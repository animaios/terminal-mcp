CC      ?= gcc
CFLAGS  ?= -O2 -Wall -Wextra -D_GNU_SOURCE
LDFLAGS ?= -lutil

.PHONY: all clean

all: ptyd

ptyd: ptyd.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

clean:
	rm -f ptyd
