#!/usr/bin/env bash
# One-time setup for external VM nodes (index.ts), with the AWS CLI signed in as an admin of the account and the
# Tailscale OAuth client's secret in TS_OAUTH_CLIENT_SECRET (a client with the auth_keys scope and tag:biscotti-node).
# Usage: TS_OAUTH_CLIENT_SECRET=… plugins/external-vm-node/setup.sh REGION GATE_TAILSCALE_NAME REV [INSTANCE_TYPE]
#
# Makes the nodes' instance role (it reads only the Tailscale secret, put in Parameter Store here), a security group
# with no inbound rules, the `biscotti-node` launch template (nested virtualization, 30 GB), and the gate's IAM user,
# which may launch, start and stop only instances tagged biscotti-role=node. Launches nothing: the gate does, when it
# needs one. Prints the settings for the gate's .env.
#
# The tailnet's access controls need, with the biscotti host tagged tag:biscotti:
#   "tagOwners": { "tag:biscotti-node": ["autogroup:admin"] },
#   "grants": [
#     { "src": ["tag:biscotti"], "dst": ["tag:biscotti-node"], "ip": ["tcp:7400", "tcp:4000", "tcp:3211", "tcp:6901", "tcp:9223", "tcp:2222"] },
#     { "src": ["tag:biscotti-node"], "dst": ["tag:biscotti"], "ip": ["tcp:18101-18199"] },
#     { "src": ["autogroup:member"], "dst": ["tag:biscotti-node"], "ip": ["tcp:10441", "tcp:2222"] }
#   ]
set -euo pipefail
REGION=$1 GATE=$2 REV=$3 TYPE=${4:-m8i.large}
: "${TS_OAUTH_CLIENT_SECRET:?the Tailscale OAuth client's secret, please}"
export AWS_REGION=$REGION AWS_PAGER=""
account=$(aws sts get-caller-identity --query Account --output text)
param="arn:aws:ssm:$REGION:$account:parameter/biscotti/node/tailscale"

aws ssm put-parameter --name /biscotti/node/tailscale --type SecureString --overwrite --value "$TS_OAUTH_CLIENT_SECRET" >/dev/null
aws iam create-role --role-name biscotti-node --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
aws iam put-role-policy --role-name biscotti-node --policy-name tailscale --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameter\",\"Resource\":\"$param\"}]}"
aws iam create-instance-profile --instance-profile-name biscotti-node >/dev/null
aws iam add-role-to-instance-profile --instance-profile-name biscotti-node --role-name biscotti-node
sleep 10 # IAM is eventually consistent

# The newest official NixOS 26.05 x86_64 image, as the installer app picks it.
ami=$(aws ec2 describe-images --owners 427812963091 --filters 'Name=name,Values=nixos/26.05*' 'Name=architecture,Values=x86_64' \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)
sg=$(aws ec2 create-security-group --group-name biscotti-node --description "biscotti external VM nodes: no inbound" --query GroupId --output text)
userdata=$(sed -e "s/REV/$REV/" -e "s/GATE/$GATE/" "$(dirname "$0")/user-data.nix" | base64 | tr -d '\n')
template=$(aws ec2 create-launch-template --launch-template-name biscotti-node --query LaunchTemplate.LaunchTemplateId --output text \
  --launch-template-data "{
    \"ImageId\": \"$ami\", \"InstanceType\": \"$TYPE\", \"CpuOptions\": {\"NestedVirtualization\": \"enabled\"},
    \"IamInstanceProfile\": {\"Name\": \"biscotti-node\"}, \"SecurityGroupIds\": [\"$sg\"],
    \"MetadataOptions\": {\"HttpTokens\": \"required\", \"HttpPutResponseHopLimit\": 1, \"InstanceMetadataTags\": \"enabled\"},
    \"BlockDeviceMappings\": [{\"DeviceName\": \"/dev/xvda\", \"Ebs\": {\"VolumeSize\": 30, \"VolumeType\": \"gp3\"}}],
    \"TagSpecifications\": [{\"ResourceType\": \"volume\", \"Tags\": [{\"Key\": \"biscotti-role\", \"Value\": \"node\"}]}],
    \"UserData\": \"$userdata\"
  }")

aws iam create-user --user-name biscotti-gate >/dev/null
aws iam put-user-policy --user-name biscotti-gate --policy-name nodes --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[
  {\"Effect\":\"Allow\",\"Action\":\"ec2:RunInstances\",\"Resource\":[\"arn:aws:ec2:$REGION:$account:instance/*\",\"arn:aws:ec2:$REGION:$account:volume/*\"],
   \"Condition\":{\"StringEquals\":{\"aws:RequestTag/biscotti-role\":\"node\"}}},
  {\"Effect\":\"Allow\",\"Action\":\"ec2:RunInstances\",\"Resource\":[\"arn:aws:ec2:$REGION:$account:launch-template/$template\",
   \"arn:aws:ec2:$REGION::image/*\",\"arn:aws:ec2:$REGION:$account:subnet/*\",\"arn:aws:ec2:$REGION:$account:network-interface/*\",
   \"arn:aws:ec2:$REGION:$account:security-group/$sg\"]},
  {\"Effect\":\"Allow\",\"Action\":\"ec2:CreateTags\",\"Resource\":[\"arn:aws:ec2:$REGION:$account:instance/*\",\"arn:aws:ec2:$REGION:$account:volume/*\"],
   \"Condition\":{\"StringEquals\":{\"ec2:CreateAction\":\"RunInstances\"}}},
  {\"Effect\":\"Allow\",\"Action\":[\"ec2:StartInstances\",\"ec2:StopInstances\"],\"Resource\":\"arn:aws:ec2:$REGION:$account:instance/*\",
   \"Condition\":{\"StringEquals\":{\"ec2:ResourceTag/biscotti-role\":\"node\"}}},
  {\"Effect\":\"Allow\",\"Action\":[\"ec2:DescribeInstances\",\"ec2:DescribeLaunchTemplateVersions\"],\"Resource\":\"*\"},
  {\"Effect\":\"Allow\",\"Action\":\"iam:PassRole\",\"Resource\":\"arn:aws:iam::$account:role/biscotti-node\"}]}"
read -r id secret < <(aws iam create-access-key --user-name biscotti-gate --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)

cat <<OUT

Add to the biscotti host's /var/lib/biscotti/.env, and "external-vm-node" to its biscotti.json:
AWS_REGION=$REGION
AWS_ACCESS_KEY_ID=$id
AWS_SECRET_ACCESS_KEY=$secret
NODE_MAX=4
OUT
