#!/usr/bin/env bash
# One-time AWS setup for biscotti's cloud machines (NODE.md), with the AWS CLI signed in as an admin of the account.
# Usage: installer/aws/node-setup.sh REGION GATE_TAILSCALE_NAME REV [INSTANCE_TYPE]
# Makes the nodes' instance role (reads only their Tailscale keys), a security group with no inbound rules, the
# `biscotti-node` launch template, and the gate's IAM user, which may launch, start, stop and terminate only instances
# tagged biscotti-role=node (the gate caps them at NODE_MAX, 4). Launches nothing: the gate does, when it needs one.
# Prints the settings for the gate's .env.
set -euo pipefail
REGION=$1 GATE=$2 REV=$3 TYPE=${4:-m8i.xlarge}
export AWS_REGION=$REGION AWS_PAGER=""
account=$(aws sts get-caller-identity --query Account --output text)
params="arn:aws:ssm:$REGION:$account:parameter/biscotti/node/*"

aws iam create-role --role-name biscotti-node --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
aws iam put-role-policy --role-name biscotti-node --policy-name tailscale-key --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameter\",\"Resource\":\"$params\"}]}"
aws iam create-instance-profile --instance-profile-name biscotti-node >/dev/null
aws iam add-role-to-instance-profile --instance-profile-name biscotti-node --role-name biscotti-node
sleep 10 # IAM is eventually consistent

# The newest official NixOS 26.05 x86_64 image, as the installer app picks it.
ami=$(aws ec2 describe-images --owners 427812963091 --filters 'Name=name,Values=nixos/26.05*' 'Name=architecture,Values=x86_64' \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)
sg=$(aws ec2 create-security-group --group-name biscotti-node --description "biscotti cloud machines: no inbound" --query GroupId --output text)
userdata=$(sed -e "s/REV/$REV/" -e "s/GATE/$GATE/" "$(dirname "$0")/node-user-data.nix" | base64 | tr -d '\n')
template=$(aws ec2 create-launch-template --launch-template-name biscotti-node --query LaunchTemplate.LaunchTemplateId --output text \
  --launch-template-data "{
    \"ImageId\": \"$ami\", \"InstanceType\": \"$TYPE\", \"CpuOptions\": {\"NestedVirtualization\": \"enabled\"},
    \"IamInstanceProfile\": {\"Name\": \"biscotti-node\"}, \"SecurityGroupIds\": [\"$sg\"],
    \"MetadataOptions\": {\"HttpTokens\": \"required\", \"HttpPutResponseHopLimit\": 1, \"InstanceMetadataTags\": \"enabled\"},
    \"BlockDeviceMappings\": [{\"DeviceName\": \"/dev/xvda\", \"Ebs\": {\"VolumeSize\": 100, \"VolumeType\": \"gp3\"}}],
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
  {\"Effect\":\"Allow\",\"Action\":[\"ec2:StartInstances\",\"ec2:StopInstances\",\"ec2:TerminateInstances\"],\"Resource\":\"arn:aws:ec2:$REGION:$account:instance/*\",
   \"Condition\":{\"StringEquals\":{\"ec2:ResourceTag/biscotti-role\":\"node\"}}},
  {\"Effect\":\"Allow\",\"Action\":[\"ec2:DescribeInstances\",\"ec2:DescribeLaunchTemplateVersions\"],\"Resource\":\"*\"},
  {\"Effect\":\"Allow\",\"Action\":\"iam:PassRole\",\"Resource\":\"arn:aws:iam::$account:role/biscotti-node\"},
  {\"Effect\":\"Allow\",\"Action\":\"ssm:PutParameter\",\"Resource\":\"$params\"}]}"
read -r id secret < <(aws iam create-access-key --user-name biscotti-gate --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)

cat <<OUT

Add to the biscotti host's /var/lib/biscotti/.env (plus TS_OAUTH_CLIENT_ID and TS_OAUTH_CLIENT_SECRET, NODE.md):
AWS_REGION=$REGION
AWS_ACCESS_KEY_ID=$id
AWS_SECRET_ACCESS_KEY=$secret
NODE_MAX=4
OUT
