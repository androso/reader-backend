#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:?Set AWS_ACCOUNT_ID}"
IMAGE_TAG="${IMAGE_TAG:?Set IMAGE_TAG to the commit SHA}"
ECS_CLUSTER="${ECS_CLUSTER:?Set ECS_CLUSTER}"
REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

register_revision() {
    local current_arn="$1" container="$2" image_service="$3"
    local definition image_uri new_arn
    definition=$(aws ecs describe-task-definition --region "$AWS_REGION" \
        --task-definition "$current_arn" --query taskDefinition --output json)
    image_uri="${REGISTRY}/reader-${image_service}:${IMAGE_TAG}"
    new_arn=$(jq --arg container "$container" --arg image "$image_uri" '
        del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy)
        | (.containerDefinitions[] | select(.name == $container).image) = $image
    ' <<<"$definition" | aws ecs register-task-definition --region "$AWS_REGION" \
        --cli-input-json file:///dev/stdin --query taskDefinition.taskDefinitionArn --output text)
    printf '%s' "$new_arn"
}

service_task() {
    aws ecs describe-services --region "$AWS_REGION" --cluster "$ECS_CLUSTER" \
        --services "$1" --query 'services[0].taskDefinition' --output text
}

api_arn=$(register_revision "$(service_task "${ECS_API_SERVICE:?Set ECS_API_SERVICE}")" api api)
worker_arn=$(register_revision "$(service_task "${ECS_WORKER_SERVICE:?Set ECS_WORKER_SERVICE}")" worker worker)
web_arn=$(register_revision "$(service_task "${ECS_WEB_SERVICE:?Set ECS_WEB_SERVICE}")" web web)
migration_arn=$(register_revision "${ECS_MIGRATION_TASK_DEFINITION:?Set ECS_MIGRATION_TASK_DEFINITION}" migration api)

cat <<EOF
ECS_API_TASK_DEFINITION=$api_arn
ECS_WORKER_TASK_DEFINITION=$worker_arn
ECS_WEB_TASK_DEFINITION=$web_arn
ECS_MIGRATION_TASK_DEFINITION=$migration_arn
EOF
