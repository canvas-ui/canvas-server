#!/bin/bash
set -e

# Canvas SSHD Docker Image Build Script

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="canvas/sshd"
IMAGE_TAG="${1:-latest}"

echo "Building Canvas SSHD Docker image..."
echo "Image: $IMAGE_NAME:$IMAGE_TAG"
echo "Build context: $SCRIPT_DIR"

# Build the Docker image
docker build -t "$IMAGE_NAME:$IMAGE_TAG" "$SCRIPT_DIR"

echo "Build complete!"
echo "Image: $IMAGE_NAME:$IMAGE_TAG"
echo ""
echo "To test the image:"
echo "  docker run --rm -p 22222:22 -v \$(pwd)/server/users:/users $IMAGE_NAME:$IMAGE_TAG"
echo ""
echo "To push the image:"
echo "  docker push $IMAGE_NAME:$IMAGE_TAG"
