// A Firecracker page-fault handler that loads all of guest memory from the snapshot at the first fault, so a
// restored VM's memory can be backed by 2M huge pages (which file-backed restore can't do) and never faults again.
// Usage: fault-all SOCKET MEMFILE. Serves one Firecracker, then exits when it does.
#include <fcntl.h>
#include <linux/userfaultfd.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

static void die(const char *what) { perror(what); exit(1); }

int main(int argc, char **argv) {
  if (argc != 3) { fprintf(stderr, "usage: fault-all SOCKET MEMFILE\n"); return 2; }
  int mem = open(argv[2], O_RDONLY);
  struct stat st;
  if (mem < 0 || fstat(mem, &st)) die("memfile");
  char *src = mmap(NULL, st.st_size, PROT_READ, MAP_PRIVATE | MAP_POPULATE, mem, 0);
  if (src == MAP_FAILED) die("mmap");

  int sock = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un addr = {.sun_family = AF_UNIX};
  strncpy(addr.sun_path, argv[1], sizeof addr.sun_path - 1);
  unlink(argv[1]);
  if (bind(sock, (struct sockaddr *)&addr, sizeof addr) || listen(sock, 1)) die("socket");
  int fc = accept(sock, NULL, NULL);
  if (fc < 0) die("accept");

  // Firecracker sends the guest regions as JSON, with the userfaultfd attached.
  char body[4096] = {0}, control[CMSG_SPACE(sizeof(int))];
  struct iovec iov = {body, sizeof body - 1};
  struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control, .msg_controllen = sizeof control};
  if (recvmsg(fc, &msg, 0) <= 0 || !CMSG_FIRSTHDR(&msg)) die("recvmsg");
  int uffd;
  memcpy(&uffd, CMSG_DATA(CMSG_FIRSTHDR(&msg)), sizeof uffd);

  struct pollfd fds[2] = {{uffd, POLLIN, 0}, {fc, POLLIN, 0}};
  for (int loaded = 0;;) {
    if (poll(fds, 2, -1) < 0) die("poll");
    if (fds[1].revents) break;  // Firecracker exited.
    struct uffd_msg event;
    if (read(uffd, &event, sizeof event) != sizeof event) continue;
    if (event.event != UFFD_EVENT_PAGEFAULT || loaded) continue;
    for (char *r = strstr(body, "base_host_virt_addr"); r; r = strstr(r + 1, "base_host_virt_addr")) {
      unsigned long long base, size, offset;
      if (sscanf(r, "base_host_virt_addr\":%llu,\"size\":%llu,\"offset\":%llu", &base, &size, &offset) != 3) {
        fprintf(stderr, "unexpected regions: %s\n", body);
        return 1;
      }
      for (unsigned long long done = 0; done < size;) {
        struct uffdio_copy copy = {.dst = base + done, .src = (unsigned long long)src + offset + done, .len = size - done};
        if (ioctl(uffd, UFFDIO_COPY, &copy) && copy.copy <= 0) die("UFFDIO_COPY");
        done += copy.copy;
      }
    }
    loaded = 1;
  }
  return 0;
}
