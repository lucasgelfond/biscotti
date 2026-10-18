# Paste as the instance's user data (replace REV with a commit). No secrets here: user data is readable by anyone
# with EC2 describe access and by every process on the instance.
{ ... }:
{
  imports = [ "${builtins.fetchTarball "https://github.com/lucasgelfond/biscotti/archive/REV.tar.gz"}/installer/aws" ];
}
