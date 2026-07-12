#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:?Set AWS_ACCOUNT_ID to your AWS account ID}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"
PROJECT_NAME="${PROJECT_NAME:-reader}"

REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

aws ecr get-login-password --region "$AWS_REGION" \
    | docker login --username AWS --password-stdin "$REGISTRY"

for service in api worker web; do
    repository="${PROJECT_NAME}-${service}"
    image_uri="${REGISTRY}/${repository}:${IMAGE_TAG}"

    aws ecr describe-repositories \
        --region "$AWS_REGION" \
        --repository-names "$repository" >/dev/null 2>&1 \
        || aws ecr create-repository \
            --region "$AWS_REGION" \
            --repository-name "$repository" \
            --image-scanning-configuration scanOnPush=true >/dev/null

    if [[ "$service" == "web" ]]; then
        : "${NEXT_PUBLIC_API_URL:?Set NEXT_PUBLIC_API_URL for the web image build}"
        : "${NEXT_PUBLIC_GOOGLE_CLIENT_ID:?Set NEXT_PUBLIC_GOOGLE_CLIENT_ID for the web image build}"

        docker build \
            -f Dockerfile.web \
            --build-arg "NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}" \
            --build-arg "NEXT_PUBLIC_GOOGLE_CLIENT_ID=${NEXT_PUBLIC_GOOGLE_CLIENT_ID}" \
            -t "${repository}:${IMAGE_TAG}" .
    else
        docker build -f "Dockerfile.${service}" -t "${repository}:${IMAGE_TAG}" .
    fi

    docker tag "${repository}:${IMAGE_TAG}" "$image_uri"
    docker push "$image_uri"
    printf '%s\n' "$image_uri"
done
