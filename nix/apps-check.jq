# What in an app's compose config (`docker compose config --format json`) reaches past the app's own directory, $dir:
# one line each, nothing when it's fine. A guard against mistakes, not a sandbox: whoever can write $dir is root.
def inside: . == $dir or startswith($dir + "/");
def file: if type == "string" then . else .path end;
def device: if type == "string" then split(":")[0] else .source end;

(.services // {} | to_entries[] | .key as $s | .value | (
  (select(.privileged) | "\($s): privileged"),
  (select((.network_mode // "") | test("^(host|container:)")) | "\($s): network_mode \(.network_mode)"),
  (["pid", "ipc", "uts", "userns_mode"][] as $ns | select(.[$ns] == "host") | "\($s): \($ns) host"),
  (.volumes[]? | select(.type == "bind" and (.source | inside | not)) | "\($s): mounts \(.source)"),
  (.volumes_from[]? | select(startswith("container:")) | "\($s): volumes_from \(.)"),
  (.env_file[]? | file | select(inside | not) | "\($s): env_file \(.)"),
  (.build.context? // empty | select(startswith("/") and (inside | not)) | "\($s): builds from \(.)"),
  (.devices[]? | device | select(. != "/dev/net/tun") | "\($s): device \(.)")
)),
(["volumes", "networks"][] as $k | .[$k] // {} | to_entries[] | select(.value.external) | "\($k): \(.key) is external"),
(.volumes // {} | to_entries[] | .value.driver_opts.device // empty | select(inside | not) | "volumes: binds \(.)"),
(["secrets", "configs"][] as $k | .[$k] // {} | to_entries[] | .value.file // empty | select(inside | not) | "\($k): reads \(.)")
