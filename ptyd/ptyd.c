/*
 * ptyd — Lightweight PTY daemon for terminal-mcp
 *
 * Manages pseudo-terminal sessions via forkpty() and exposes a JSON-lines
 * protocol over a Unix domain socket.  Single-threaded, epoll-based event loop.
 *
 * Build:  gcc -O2 -Wall -Wextra -D_GNU_SOURCE -o ptyd ptyd.c -lutil
 */

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pty.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

/* ── Tunables ──────────────────────────────────────────────────────── */
#define MAX_SESSIONS    10
#define MAX_EVENTS      64
#define READ_BUF_SIZE   (64 * 1024)
#define RECV_BUF_SIZE   (256 * 1024)
#define SEND_BUF_SIZE   (256 * 1024)
#define JSON_BUF_SIZE   (128 * 1024)
#define MAX_ENV_VARS    64
#define MAX_ARGS        32

/* ── Base64 ────────────────────────────────────────────────────────── */
static const char B64_TABLE[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static int base64_encode(const uint8_t *src, size_t len, char *dst, size_t dst_size) {
    size_t out_len = 4 * ((len + 2) / 3);
    if (out_len + 1 > dst_size) return -1;
    size_t i, j = 0;
    for (i = 0; i + 2 < len; i += 3) {
        uint32_t n = ((uint32_t)src[i] << 16) | ((uint32_t)src[i+1] << 8) | src[i+2];
        dst[j++] = B64_TABLE[(n >> 18) & 0x3F];
        dst[j++] = B64_TABLE[(n >> 12) & 0x3F];
        dst[j++] = B64_TABLE[(n >>  6) & 0x3F];
        dst[j++] = B64_TABLE[ n        & 0x3F];
    }
    if (i < len) {
        uint32_t n = (uint32_t)src[i] << 16;
        if (i + 1 < len) n |= (uint32_t)src[i+1] << 8;
        dst[j++] = B64_TABLE[(n >> 18) & 0x3F];
        dst[j++] = B64_TABLE[(n >> 12) & 0x3F];
        dst[j++] = (i + 1 < len) ? B64_TABLE[(n >> 6) & 0x3F] : '=';
        dst[j++] = '=';
    }
    dst[j] = '\0';
    return (int)j;
}

static int base64_decode(const char *src, size_t len, uint8_t *dst, size_t dst_size) {
    static const int8_t d[] = {
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,
        52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-1,-1,-1,
        -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,
        15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,
        -1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,
        41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1
    };
    size_t out_len = (len / 4) * 3;
    if (len >= 1 && src[len-1] == '=') out_len--;
    if (len >= 2 && src[len-2] == '=') out_len--;
    if (out_len > dst_size) return -1;
    size_t j = 0;
    for (size_t i = 0; i < len; ) {
        uint32_t n = 0;
        int n_pad = 0;
        for (int k = 0; k < 4; k++, i++) {
            char c = (i < len) ? src[i] : '=';
            if (c == '=') { n_pad++; n <<= 6; }
            else {
                int v = ((unsigned char)c < 128) ? d[(unsigned char)c] : -1;
                if (v < 0) return -1;
                n = (n << 6) | (uint32_t)v;
            }
        }
        (void)n_pad;
        if (j < out_len) dst[j++] = (uint8_t)(n >> 16);
        if (j < out_len) dst[j++] = (uint8_t)(n >> 8);
        if (j < out_len) dst[j++] = (uint8_t)(n);
    }
    return (int)j;
}

/* ── Minimal JSON helpers ──────────────────────────────────────────── */

/* Skip whitespace */
static const char *skip_ws(const char *p) {
    while (*p && isspace((unsigned char)*p)) p++;
    return p;
}

/* Extract a string value for a given key from a flat JSON object.
 * Returns allocated string (caller must free) or NULL. */
static char *json_get_string(const char *json, const char *key) {
    char pattern[128];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
    if (!p) return NULL;
    p += strlen(pattern);
    p = skip_ws(p);
    if (*p != ':') return NULL;
    p = skip_ws(p + 1);
    if (*p != '"') return NULL;
    p++;
    const char *start = p;
    while (*p && *p != '"') {
        if (*p == '\\') p++; /* skip escaped char */
        if (*p) p++;
    }
    size_t len = (size_t)(p - start);
    char *result = malloc(len + 1);
    if (!result) return NULL;
    /* Simple unescape */
    size_t j = 0;
    for (size_t i = 0; i < len; i++) {
        if (start[i] == '\\' && i + 1 < len) {
            i++;
            switch (start[i]) {
                case 'n': result[j++] = '\n'; break;
                case 'r': result[j++] = '\r'; break;
                case 't': result[j++] = '\t'; break;
                case '\\': result[j++] = '\\'; break;
                case '"': result[j++] = '"'; break;
                default: result[j++] = start[i]; break;
            }
        } else {
            result[j++] = start[i];
        }
    }
    result[j] = '\0';
    return result;
}

/* Extract an integer value for a given key. Returns -1 on failure. */
static int json_get_int(const char *json, const char *key) {
    char pattern[128];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
    if (!p) return -1;
    p += strlen(pattern);
    p = skip_ws(p);
    if (*p != ':') return -1;
    p = skip_ws(p + 1);
    return atoi(p);
}

/* Extract string array for a given key. Returns count, fills out[]. */
static int json_get_string_array(const char *json, const char *key, char **out, int max) {
    char pattern[128];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
    if (!p) return 0;
    p += strlen(pattern);
    p = skip_ws(p);
    if (*p != ':') return 0;
    p = skip_ws(p + 1);
    if (*p != '[') return 0;
    p++;
    int count = 0;
    while (*p && *p != ']' && count < max) {
        p = skip_ws(p);
        if (*p == '"') {
            p++;
            const char *start = p;
            while (*p && *p != '"') {
                if (*p == '\\') p++;
                if (*p) p++;
            }
            size_t len = (size_t)(p - start);
            out[count] = malloc(len + 1);
            memcpy(out[count], start, len);
            out[count][len] = '\0';
            count++;
            if (*p == '"') p++;
        }
        p = skip_ws(p);
        if (*p == ',') p++;
    }
    return count;
}

/* Extract env map: "env":{"K":"V",...} → fills keys[] and vals[], returns count */
static int json_get_env_map(const char *json, const char *key, char **keys, char **vals, int max) {
    char pattern[128];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
    if (!p) return 0;
    p += strlen(pattern);
    p = skip_ws(p);
    if (*p != ':') return 0;
    p = skip_ws(p + 1);
    if (*p != '{') return 0;
    p++;
    int count = 0;
    while (*p && *p != '}' && count < max) {
        p = skip_ws(p);
        if (*p != '"') break;
        p++;
        const char *ks = p;
        while (*p && *p != '"') { if (*p == '\\') p++; p++; }
        keys[count] = strndup(ks, (size_t)(p - ks));
        if (*p == '"') p++;
        p = skip_ws(p);
        if (*p == ':') p++;
        p = skip_ws(p);
        if (*p != '"') break;
        p++;
        const char *vs = p;
        while (*p && *p != '"') { if (*p == '\\') p++; p++; }
        vals[count] = strndup(vs, (size_t)(p - vs));
        if (*p == '"') p++;
        count++;
        p = skip_ws(p);
        if (*p == ',') p++;
    }
    return count;
}

/* ── Session table ─────────────────────────────────────────────────── */
struct pty_session {
    bool     alive;
    uint32_t id;
    int      master_fd;
    pid_t    child_pid;
    int      exit_code;
    int      exit_signal;
    bool     exited;
};

static struct pty_session sessions[MAX_SESSIONS];
static uint32_t next_session_id = 1;

/* ── Globals ───────────────────────────────────────────────────────── */
static int listen_fd  = -1;
static int client_fd  = -1;
static int epfd       = -1;
static int sigchld_fd = -1;
static volatile sig_atomic_t running = 1;
static char socket_path[256];

static char recv_buf[RECV_BUF_SIZE];
static size_t recv_len = 0;

/* ── Logging ───────────────────────────────────────────────────────── */
static void log_msg(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "[ptyd] ");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
}

/* ── Signal handlers ───────────────────────────────────────────────── */
static void handle_sigchld(int sig) {
    (void)sig;
    uint64_t val = 1;
    ssize_t r = write(sigchld_fd, &val, sizeof(val));
    (void)r;
}

static void handle_sigterm(int sig) {
    (void)sig;
    running = 0;
}

/* ── Send helpers ──────────────────────────────────────────────────── */
static void send_json(const char *json) {
    if (client_fd < 0) return;
    size_t len = strlen(json);
    /* Write with newline terminator */
    ssize_t w = write(client_fd, json, len);
    if (w >= 0) write(client_fd, "\n", 1);
}

static void send_event(const char *fmt, ...) {
    char buf[JSON_BUF_SIZE];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf) - 2, fmt, ap);
    va_end(ap);
    send_json(buf);
}

/* ── Fd helpers ────────────────────────────────────────────────────── */
static void set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static void set_cloexec(int fd) {
    int flags = fcntl(fd, F_GETFD, 0);
    if (flags >= 0) fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}

/* ── Signal name mapping ───────────────────────────────────────────── */
static int signal_name_to_num(const char *name) {
    if (!name) return SIGTERM;
    if (strcmp(name, "SIGHUP") == 0)    return SIGHUP;
    if (strcmp(name, "SIGINT") == 0)    return SIGINT;
    if (strcmp(name, "SIGQUIT") == 0)   return SIGQUIT;
    if (strcmp(name, "SIGILL") == 0)    return SIGILL;
    if (strcmp(name, "SIGABRT") == 0)   return SIGABRT;
    if (strcmp(name, "SIGFPE") == 0)    return SIGFPE;
    if (strcmp(name, "SIGKILL") == 0)   return SIGKILL;
    if (strcmp(name, "SIGSEGV") == 0)   return SIGSEGV;
    if (strcmp(name, "SIGPIPE") == 0)   return SIGPIPE;
    if (strcmp(name, "SIGALRM") == 0)   return SIGALRM;
    if (strcmp(name, "SIGTERM") == 0)   return SIGTERM;
    if (strcmp(name, "SIGUSR1") == 0)   return SIGUSR1;
    if (strcmp(name, "SIGUSR2") == 0)   return SIGUSR2;
    if (strcmp(name, "SIGCHLD") == 0)   return SIGCHLD;
    if (strcmp(name, "SIGCONT") == 0)   return SIGCONT;
    if (strcmp(name, "SIGSTOP") == 0)   return SIGSTOP;
    if (strcmp(name, "SIGTSTP") == 0)   return SIGTSTP;
    if (strcmp(name, "SIGTTIN") == 0)   return SIGTTIN;
    if (strcmp(name, "SIGTTOU") == 0)   return SIGTTOU;
    return SIGTERM;
}

static const char *signal_to_name(int sig) {
    switch (sig) {
        case SIGHUP:    return "SIGHUP";
        case SIGINT:    return "SIGINT";
        case SIGQUIT:   return "SIGQUIT";
        case SIGILL:    return "SIGILL";
        case SIGABRT:   return "SIGABRT";
        case SIGFPE:    return "SIGFPE";
        case SIGKILL:   return "SIGKILL";
        case SIGSEGV:   return "SIGSEGV";
        case SIGPIPE:   return "SIGPIPE";
        case SIGALRM:   return "SIGALRM";
        case SIGTERM:   return "SIGTERM";
        case SIGUSR1:   return "SIGUSR1";
        case SIGUSR2:   return "SIGUSR2";
        case SIGCHLD:   return "SIGCHLD";
        case SIGCONT:   return "SIGCONT";
        case SIGSTOP:   return "SIGSTOP";
        case SIGTSTP:   return "SIGTSTP";
        case SIGTTIN:   return "SIGTTIN";
        case SIGTTOU:   return "SIGTTOU";
        default:        return "UNKNOWN";
    }
}

/* ── Command handlers ──────────────────────────────────────────────── */

static void handle_start(const char *line) {
    char *req_id = json_get_string(line, "reqId");
    char *shell  = json_get_string(line, "shell");
    char *cwd    = json_get_string(line, "cwd");
    int cols     = json_get_int(line, "cols");
    int rows     = json_get_int(line, "rows");

    if (cols <= 0) cols = 120;
    if (rows <= 0) rows = 30;

    char *args_arr[MAX_ARGS];
    int nargs = json_get_string_array(line, "args", args_arr, MAX_ARGS - 1);

    char *env_keys[MAX_ENV_VARS], *env_vals[MAX_ENV_VARS];
    int nenv = json_get_env_map(line, "env", env_keys, env_vals, MAX_ENV_VARS);

    /* Find free session slot */
    int slot = -1;
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (!sessions[i].alive && !sessions[i].exited) {
            slot = i;
            break;
        }
    }

    if (slot < 0) {
        send_event("{\"type\":\"error\",\"reqId\":\"%s\",\"message\":\"No free session slots\"}",
                   req_id ? req_id : "");
        goto cleanup;
    }

    struct winsize ws = {
        .ws_row = (unsigned short)rows,
        .ws_col = (unsigned short)cols,
        .ws_xpixel = 0,
        .ws_ypixel = 0,
    };

    int master_fd;
    pid_t pid = forkpty(&master_fd, NULL, NULL, &ws);

    if (pid < 0) {
        send_event("{\"type\":\"error\",\"reqId\":\"%s\",\"message\":\"forkpty failed: %s\"}",
                   req_id ? req_id : "", strerror(errno));
        goto cleanup;
    }

    if (pid == 0) {
        /* Child process */
        if (cwd && strlen(cwd) > 0) {
            if (chdir(cwd) < 0) {
                perror("chdir");
                _exit(127);
            }
        }

        /* Set environment variables */
        for (int i = 0; i < nenv; i++) {
            setenv(env_keys[i], env_vals[i], 1);
        }

        /* Build argv: shell + args */
        const char *argv[MAX_ARGS + 2];
        argv[0] = shell ? shell : "/bin/sh";
        for (int i = 0; i < nargs; i++) {
            argv[i + 1] = args_arr[i];
        }
        argv[nargs + 1] = NULL;

        execvp(argv[0], (char *const *)argv);
        perror("execvp");
        _exit(127);
    }

    /* Parent process */
    set_nonblocking(master_fd);
    set_cloexec(master_fd);

    sessions[slot].alive     = true;
    sessions[slot].id        = next_session_id++;
    sessions[slot].master_fd = master_fd;
    sessions[slot].child_pid = pid;
    sessions[slot].exit_code = 0;
    sessions[slot].exit_signal = 0;
    sessions[slot].exited    = false;

    struct epoll_event ev = {
        .events = EPOLLIN,
        .data.fd = master_fd,
    };
    epoll_ctl(epfd, EPOLL_CTL_ADD, master_fd, &ev);

    send_event("{\"type\":\"response\",\"reqId\":\"%s\",\"sessionId\":%u,\"pid\":%d}",
               req_id ? req_id : "", sessions[slot].id, (int)pid);

    log_msg("Session %u started (pid %d, fd %d, shell=%s)",
            sessions[slot].id, (int)pid, master_fd, shell ? shell : "/bin/sh");

cleanup:
    free(req_id);
    free(shell);
    free(cwd);
    for (int i = 0; i < nargs; i++) free(args_arr[i]);
    for (int i = 0; i < nenv; i++) { free(env_keys[i]); free(env_vals[i]); }
}

static struct pty_session *find_session(uint32_t id) {
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (sessions[i].id == id && (sessions[i].alive || sessions[i].exited))
            return &sessions[i];
    }
    return NULL;
}

static void handle_write(const char *line) {
    int sid = json_get_int(line, "sessionId");
    char *data_b64 = json_get_string(line, "data");
    if (!data_b64) return;

    struct pty_session *s = find_session((uint32_t)sid);
    if (!s || !s->alive) { free(data_b64); return; }

    uint8_t decoded[READ_BUF_SIZE];
    int dec_len = base64_decode(data_b64, strlen(data_b64), decoded, sizeof(decoded));
    free(data_b64);
    if (dec_len <= 0) return;

    ssize_t w = write(s->master_fd, decoded, (size_t)dec_len);
    (void)w;
}

static void handle_resize(const char *line) {
    int sid  = json_get_int(line, "sessionId");
    int cols = json_get_int(line, "cols");
    int rows = json_get_int(line, "rows");

    struct pty_session *s = find_session((uint32_t)sid);
    if (!s || !s->alive) return;

    struct winsize ws = {
        .ws_row = (unsigned short)rows,
        .ws_col = (unsigned short)cols,
        .ws_xpixel = 0,
        .ws_ypixel = 0,
    };
    ioctl(s->master_fd, TIOCSWINSZ, &ws);
}

static void handle_signal(const char *line) {
    int sid = json_get_int(line, "sessionId");
    char *sig_name = json_get_string(line, "signal");

    struct pty_session *s = find_session((uint32_t)sid);
    if (!s || !s->alive) { free(sig_name); return; }

    int sig = signal_name_to_num(sig_name);
    free(sig_name);

    /* Kill the entire process group */
    kill(-s->child_pid, sig);
}

static void handle_kill(const char *line) {
    int sid = json_get_int(line, "sessionId");
    struct pty_session *s = find_session((uint32_t)sid);
    if (!s || !s->alive) return;

    kill(-s->child_pid, SIGTERM);
}

static void handle_list(const char *line) {
    char *req_id = json_get_string(line, "reqId");
    char buf[JSON_BUF_SIZE];
    int off = snprintf(buf, sizeof(buf),
        "{\"type\":\"response\",\"reqId\":\"%s\",\"sessions\":[", req_id ? req_id : "");
    bool first = true;
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (sessions[i].alive) {
            if (!first) off += snprintf(buf + off, sizeof(buf) - (size_t)off, ",");
            off += snprintf(buf + off, sizeof(buf) - (size_t)off,
                "{\"sessionId\":%u,\"pid\":%d,\"alive\":true}",
                sessions[i].id, (int)sessions[i].child_pid);
            first = false;
        }
    }
    snprintf(buf + off, sizeof(buf) - (size_t)off, "]}");
    send_json(buf);
    free(req_id);
}

static void handle_ping(const char *line) {
    char *req_id = json_get_string(line, "reqId");
    send_event("{\"type\":\"response\",\"reqId\":\"%s\",\"pong\":true}", req_id ? req_id : "");
    free(req_id);
}

/* ── Dispatch ──────────────────────────────────────────────────────── */
static void dispatch_line(const char *line) {
    char *type = json_get_string(line, "type");
    if (!type) return;

    if (strcmp(type, "start") == 0)       handle_start(line);
    else if (strcmp(type, "write") == 0)   handle_write(line);
    else if (strcmp(type, "resize") == 0)  handle_resize(line);
    else if (strcmp(type, "signal") == 0)  handle_signal(line);
    else if (strcmp(type, "kill") == 0)    handle_kill(line);
    else if (strcmp(type, "list") == 0)    handle_list(line);
    else if (strcmp(type, "ping") == 0)    handle_ping(line);
    else log_msg("Unknown command type: %s", type);

    free(type);
}

/* ── Process incoming data from client ─────────────────────────────── */
static void process_client_data(void) {
    ssize_t n = read(client_fd, recv_buf + recv_len, RECV_BUF_SIZE - recv_len - 1);
    if (n <= 0) {
        if (n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) {
            log_msg("Client disconnected");
            epoll_ctl(epfd, EPOLL_CTL_DEL, client_fd, NULL);
            close(client_fd);
            client_fd = -1;
            recv_len = 0;
        }
        return;
    }
    recv_len += (size_t)n;
    recv_buf[recv_len] = '\0';

    /* Process complete lines */
    char *start = recv_buf;
    char *nl;
    while ((nl = memchr(start, '\n', recv_len - (size_t)(start - recv_buf))) != NULL) {
        *nl = '\0';
        if (nl > start) {
            dispatch_line(start);
        }
        start = nl + 1;
    }

    /* Move incomplete line to beginning */
    size_t remaining = recv_len - (size_t)(start - recv_buf);
    if (remaining > 0) {
        memmove(recv_buf, start, remaining);
    }
    recv_len = remaining;
}

/* ── Read PTY output and send to client ────────────────────────────── */
static void read_pty_output(int master_fd) {
    struct pty_session *s = NULL;
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (sessions[i].master_fd == master_fd && sessions[i].alive) {
            s = &sessions[i];
            break;
        }
    }
    if (!s) return;

    uint8_t buf[READ_BUF_SIZE];
    ssize_t n = read(master_fd, buf, sizeof(buf));
    if (n <= 0) {
        /* EIO is normal when the slave side closes */
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
        /* PTY closed — will be cleaned up by SIGCHLD */
        return;
    }

    if (client_fd < 0) return;

    /* Base64 encode the output */
    char b64[READ_BUF_SIZE * 2];
    int b64_len = base64_encode(buf, (size_t)n, b64, sizeof(b64));
    if (b64_len < 0) return;

    /* Escape for JSON string (b64 only has safe chars, no escaping needed) */
    send_event("{\"type\":\"output\",\"sessionId\":%u,\"data\":\"%s\"}", s->id, b64);
}

/* ── Reap zombie children ──────────────────────────────────────────── */
static void reap_children(void) {
    /* Drain the eventfd */
    uint64_t val;
    ssize_t r = read(sigchld_fd, &val, sizeof(val));
    (void)r;

    int status;
    pid_t pid;
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
        for (int i = 0; i < MAX_SESSIONS; i++) {
            if (sessions[i].alive && sessions[i].child_pid == pid) {
                sessions[i].alive = false;
                sessions[i].exited = true;

                if (WIFEXITED(status)) {
                    sessions[i].exit_code = WEXITSTATUS(status);
                    sessions[i].exit_signal = 0;
                } else if (WIFSIGNALED(status)) {
                    sessions[i].exit_code = 128 + WTERMSIG(status);
                    sessions[i].exit_signal = WTERMSIG(status);
                }

                /* Remove master fd from epoll and close it */
                epoll_ctl(epfd, EPOLL_CTL_DEL, sessions[i].master_fd, NULL);
                close(sessions[i].master_fd);
                sessions[i].master_fd = -1;

                /* Send exit event */
                if (sessions[i].exit_signal) {
                    send_event("{\"type\":\"exit\",\"sessionId\":%u,\"exitCode\":%d,\"signal\":\"%s\"}",
                        sessions[i].id, sessions[i].exit_code,
                        signal_to_name(sessions[i].exit_signal));
                } else {
                    send_event("{\"type\":\"exit\",\"sessionId\":%u,\"exitCode\":%d,\"signal\":null}",
                        sessions[i].id, sessions[i].exit_code);
                }

                log_msg("Session %u exited (pid %d, code %d)",
                        sessions[i].id, (int)pid, sessions[i].exit_code);
                break;
            }
        }
    }
}

/* ── Cleanup ───────────────────────────────────────────────────────── */
static void cleanup(void) {
    /* Kill all remaining children */
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (sessions[i].alive) {
            kill(-sessions[i].child_pid, SIGTERM);
        }
    }

    /* Wait briefly for children to exit */
    usleep(100000);
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (sessions[i].alive) {
            kill(-sessions[i].child_pid, SIGKILL);
            waitpid(sessions[i].child_pid, NULL, 0);
        }
    }

    if (client_fd >= 0) close(client_fd);
    if (listen_fd >= 0) close(listen_fd);
    if (epfd >= 0) close(epfd);
    if (sigchld_fd >= 0) close(sigchld_fd);
    unlink(socket_path);

    log_msg("Cleanup complete");
}

/* ── Main ──────────────────────────────────────────────────────────── */
int main(void) {
    /* Create socket path */
    snprintf(socket_path, sizeof(socket_path), "/tmp/ptyd-%d.sock", (int)getpid());

    /* Set up signal handlers */
    sigchld_fd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
    if (sigchld_fd < 0) { perror("eventfd"); return 1; }

    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = handle_sigchld;
    sa.sa_flags = SA_RESTART | SA_NOCLDSTOP;
    sigaction(SIGCHLD, &sa, NULL);

    sa.sa_handler = handle_sigterm;
    sa.sa_flags = 0;
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);

    signal(SIGPIPE, SIG_IGN);

    /* Initialize session table */
    memset(sessions, 0, sizeof(sessions));

    /* Create epoll instance */
    epfd = epoll_create1(EPOLL_CLOEXEC);
    if (epfd < 0) { perror("epoll_create1"); return 1; }

    /* Add SIGCHLD eventfd to epoll */
    struct epoll_event ev;
    ev.events = EPOLLIN;
    ev.data.fd = sigchld_fd;
    epoll_ctl(epfd, EPOLL_CTL_ADD, sigchld_fd, &ev);

    /* Create Unix domain socket */
    unlink(socket_path);
    listen_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (listen_fd < 0) { perror("socket"); return 1; }

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    size_t path_len = strlen(socket_path);
    if (path_len >= sizeof(addr.sun_path)) path_len = sizeof(addr.sun_path) - 1;
    memcpy(addr.sun_path, socket_path, path_len);
    addr.sun_path[path_len] = '\0';

    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind");
        return 1;
    }

    if (listen(listen_fd, 1) < 0) {
        perror("listen");
        return 1;
    }

    ev.events = EPOLLIN;
    ev.data.fd = listen_fd;
    epoll_ctl(epfd, EPOLL_CTL_ADD, listen_fd, &ev);

    /* Print socket path for the parent process to parse */
    printf("SOCKET %s\n", socket_path);
    fflush(stdout);

    log_msg("Listening on %s", socket_path);

    /* Main event loop */
    struct epoll_event events[MAX_EVENTS];
    while (running) {
        int nfds = epoll_wait(epfd, events, MAX_EVENTS, 1000);
        if (nfds < 0) {
            if (errno == EINTR) continue;
            perror("epoll_wait");
            break;
        }

        for (int i = 0; i < nfds; i++) {
            int fd = events[i].data.fd;

            if (fd == listen_fd) {
                /* Accept new client connection */
                int new_fd = accept(listen_fd, NULL, NULL);
                if (new_fd >= 0) {
                    if (client_fd >= 0) {
                        /* Only one client at a time — close old */
                        epoll_ctl(epfd, EPOLL_CTL_DEL, client_fd, NULL);
                        close(client_fd);
                    }
                    client_fd = new_fd;
                    set_nonblocking(client_fd);
                    set_cloexec(client_fd);
                    ev.events = EPOLLIN;
                    ev.data.fd = client_fd;
                    epoll_ctl(epfd, EPOLL_CTL_ADD, client_fd, &ev);
                    recv_len = 0;
                    log_msg("Client connected (fd %d)", client_fd);
                }
            } else if (fd == client_fd) {
                process_client_data();
            } else if (fd == sigchld_fd) {
                reap_children();
            } else {
                /* PTY master fd */
                read_pty_output(fd);
            }
        }
    }

    cleanup();
    return 0;
}
