#!/usr/bin/env bash
# One-time setup of an overflow machine for biscotti (NODE.md), with the AWS CLI signed in as an admin of the account.
# Usage: installer/aws/node-setup.sh REGION GATE_TAILSCALE_NAME REV [INSTANCE_TYPE]
# Makes: the node's instance role (it may read only its Tailscale key), the gate's IAM user (it may start, stop and
# describe only this instance, and write only that key), and the instance itself, launched and then stopped. Prints
# the settings for the gate's .env.
set -euo pipefail
REGION=$1 GATE=$2 REV=$3 TYPE=${4:-m8i.xlarge}
export AWS_REGION=$REGION AWS_PAGER=""
account=$(aws sts get-caller-identity --query Account --output text)
param="arn:aws:ssm:$REGION:$account:parameter/biscotti/node/tailscale-key"

# The node's role: reads its one-time Tailscale key, nothing else.
aws iam create-role --role-name biscotti-node --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
aws iam put-role-policy --role-name biscotti-node --policy-name tailscale-key --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameter\",\"Resource\":\"$param\"}]}"
aws iam create-instance-profile --instance-profile-name biscotti-node >/dev/null
aws iam add-role-to-instance-profile --instance-profile-name biscotti-node --role-name biscotti-node
sleep 10 # IAM is eventually consistent

# The newest official NixOS 26.05 x86_64 image, as the installer app picks it.
ami=$(aws ec2 describe-images --owners 427812963091 --filters 'Name=name,Values=nixos/26.05*' 'Name=architecture,Values=x86_64' \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)
userdata=$(sed -e "s/REV/$REV/" -e "s/GATE/$GATE/" "$(dirname "$0")/node-user-data.nix")
sg=$(aws ec2 create-security-group --group-name biscotti-node --description "biscotti overflow machine: no inbound" --query GroupId --output text)
instance=$(aws ec2 run-instances --image-id "$ami" --instance-type "$TYPE" --count 1 \
  --cpu-options NestedVirtualization=enabled --iam-instance-profile Name=biscotti-node --security-group-ids "$sg" \
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1 \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=100,VolumeType=gp3}' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=biscotti-node},{Key=biscotti-role,Value=node}]' \
  --user-data "$userdata" --query 'Instances[0].InstanceId' --output text)
aws ec2 wait instance-running --instance-ids "$instance"
# Stopped until the gate first needs it: the gate puts the Tailscale key in place and starts it then.
aws ec2 stop-instances --instance-ids "$instance" >/dev/null

# The gate's user: this instance only, and only that key.
aws iam create-user --user-name biscotti-gate >/dev/null
aws iam put-user-policy --user-name biscotti-gate --policy-name node --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[
  {\"Effect\":\"Allow\",\"Action\":[\"ec2:StartInstances\",\"ec2:StopInstances\"],\"Resource\":\"arn:aws:ec2:$REGION:$account:instance/$instance\"},
  {\"Effect\":\"Allow\",\"Action\":\"ec2:DescribeInstances\",\"Resource\":\"*\"},
  {\"Effect\":\"Allow\",\"Action\":\"ssm:PutParameter\",\"Resource\":\"$param\"}]}"
read -r id secret < <(aws iam create-access-key --user-name biscotti-gate --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)

cat <<OUT

Add to the biscotti host's /var/lib/biscotti/.env (plus TS_OAUTH_CLIENT_ID and TS_OAUTH_CLIENT_SECRET, NODE.md):
NODE_HOST=biscotti-node.$(cut -d. -f2- <<< "$GATE")
NODE_SLOTS=4
NODE_INSTANCE=$instance
AWS_REGION=$REGION
AWS_ACCESS_KEY_ID=$id
AWS_SECRET_ACCESS_KEY=$secret
OUT
