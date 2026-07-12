#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
ECS_CLUSTER="${ECS_CLUSTER:?Set ECS_CLUSTER to your ECS cluster name}"

deploy() {
    local service="$1" task_definition="$2" previous
    previous=$(aws ecs describe-services --region "$AWS_REGION" --cluster "$ECS_CLUSTER" \
        --services "$service" --query 'services[0].taskDefinition' --output text)
    aws ecs update-service \
        --region "$AWS_REGION" \
        --cluster "$ECS_CLUSTER" \
        --service "$service" \
        --task-definition "$task_definition" >/dev/null

    if ! aws ecs wait services-stable \
        --region "$AWS_REGION" \
        --cluster "$ECS_CLUSTER" \
        --services "$service"; then
        aws ecs update-service --region "$AWS_REGION" --cluster "$ECS_CLUSTER" \
            --service "$service" --task-definition "$previous" >/dev/null
        aws ecs wait services-stable --region "$AWS_REGION" --cluster "$ECS_CLUSTER" \
            --services "$service"
        return 1
    fi
}

deploy "${ECS_API_SERVICE:?Set ECS_API_SERVICE}" "${ECS_API_TASK_DEFINITION:?Set ECS_API_TASK_DEFINITION}"
deploy "${ECS_WORKER_SERVICE:?Set ECS_WORKER_SERVICE}" "${ECS_WORKER_TASK_DEFINITION:?Set ECS_WORKER_TASK_DEFINITION}"
deploy "${ECS_WEB_SERVICE:?Set ECS_WEB_SERVICE}" "${ECS_WEB_TASK_DEFINITION:?Set ECS_WEB_TASK_DEFINITION}"
