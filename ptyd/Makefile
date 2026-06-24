CC      ?= gcc
CFLAGS  ?= -O2 -Wall -Wextra -D_GNU_SOURCE
PTYD_LDFLAGS = -lutil

.PHONY: all clean

all: ptyd

ptyd: ptyd.c
	$(CC) $(CFLAGS) -o $@ $< $(PTYD_LDFLAGS)

clean:
	rm -f ptyd
