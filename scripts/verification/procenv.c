// Prints the pid of each process whose environment holds an entry exactly equal to the one argument, KEY=VALUE.
// The verification queue's supervisor and service use it on a Mac to find the processes a service instance or a
// request started. It reads KERN_PROCARGS2, which holds argc, the executable path, the arguments, then the
// environment, so an argument, or text inside another variable's value, never counts. macOS hides the
// environment of Apple's own programs, and of other users' processes, so those never match.
// pnpm verify:queue install builds it with the system cc.

#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <unistd.h>

static int marked(pid_t pid, const char *entry, char *buffer, size_t capacity) {
  int mib[3] = { CTL_KERN, KERN_PROCARGS2, pid };
  size_t size = capacity;
  if (sysctl(mib, 3, buffer, &size, NULL, 0) != 0 || size <= sizeof(int)) return 0;
  int argc;
  memcpy(&argc, buffer, sizeof argc);
  char *at = buffer + sizeof argc;
  char *end = buffer + size;
  // The executable path, then the padding after it.
  at = memchr(at, '\0', end - at);
  if (!at) return 0;
  while (at < end && *at == '\0') at++;
  for (int index = 0; index < argc; index++) {
    char *next = at < end ? memchr(at, '\0', end - at) : NULL;
    if (!next) return 0;
    at = next + 1;
  }
  // A process that sets its title, as Node does for process.title, zero-fills the rest of its arguments' area.
  while (at < end && *at == '\0') at++;
  while (at < end && *at != '\0') {
    char *next = memchr(at, '\0', end - at);
    if (!next) return 0;
    if (strcmp(at, entry) == 0) return 1;
    at = next + 1;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 2 || !strchr(argv[1], '=')) {
    fprintf(stderr, "usage: procenv KEY=VALUE\n");
    return 2;
  }
  int mib[2] = { CTL_KERN, KERN_ARGMAX };
  int argmax;
  size_t length = sizeof argmax;
  if (sysctl(mib, 2, &argmax, &length, NULL, 0) != 0) { perror("procenv: kern.argmax"); return 1; }
  int count = proc_listallpids(NULL, 0);
  if (count <= 0) { perror("procenv: proc_listallpids"); return 1; }
  char *buffer = malloc(argmax);
  pid_t *pids = NULL;
  // Room for processes that start between the calls. A full buffer may have missed some, so it grows and reads again.
  for (int room = count + 256; ; room *= 2) {
    free(pids);
    pids = calloc(room, sizeof *pids);
    if (!pids || !buffer) { perror("procenv"); return 1; }
    count = proc_listallpids(pids, room * (int)sizeof *pids);
    if (count <= 0) { perror("procenv: proc_listallpids"); return 1; }
    if (count < room) break;
  }
  pid_t self = getpid();
  for (int index = 0; index < count; index++) {
    if (pids[index] > 0 && pids[index] != self && marked(pids[index], argv[1], buffer, (size_t)argmax)) printf("%d\n", pids[index]);
  }
  return 0;
}
