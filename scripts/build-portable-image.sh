#!/bin/bash

# This script builds a Docker image for the Canvas Server with a portable configuration.

# Set default values for environment variables
IMAGE_NAME="${IMAGE_NAME:-canvas-server}"
IMAGE_TAG="${IMAGE_TAG:-portable}"
DOCKERFILE="${DOCKERFILE:-Dockerfile}"
CONFIG_DIR="${CONFIG_DIR:-./server/config}"

# Function to display usage information
usage() {
    echo "Usage: $0 [-n image_name] [-t image_tag] [-f dockerfile] [-c config_dir]"
    echo "  -n: Image name (default: canvas-server)"
    echo "  -t: Image tag (default: portable)"
    echo "  -f: Dockerfile to use (default: Dockerfile)"
    echo "  -c: Config directory to copy (default: ./server/config)"
    exit 1
}

# Parse command line options
while getopts "n:t:f:c:h" opt; do
    case $opt in
        n) IMAGE_NAME="$OPTARG" ;;
        t) IMAGE_TAG="$OPTARG" ;;
        f) DOCKERFILE="$OPTARG" ;;
        c) CONFIG_DIR="$OPTARG" ;;
        h) usage ;;
        \?) echo "Invalid option -$OPTARG" >&2; usage ;;
    esac
done

# Check if config directory exists
if [ ! -d "$CONFIG_DIR" ]; then
    echo "Error: Config directory $CONFIG_DIR does not exist."
    exit 1
fi

# Check if Dockerfile exists
if [ ! -f "$DOCKERFILE" ]; then
    echo "Error: Dockerfile $DOCKERFILE does not exist."
    exit 1
fi

# Check if required files exist
if [ ! -f "package.json" ]; then
    echo "Error: package.json not found in current directory."
    exit 1
fi

if [ ! -f "bin/start-server.sh" ]; then
    echo "Error: bin/start-server.sh not found."
    exit 1
fi

# Build the Docker image
echo "Building Docker image: $IMAGE_NAME:$IMAGE_TAG"
echo "Using config directory: $CONFIG_DIR"
echo "Using Dockerfile: $DOCKERFILE"
echo "Node.js version: $(grep -o '"node": ">=[^"]*"' package.json | grep -o '[0-9]\+\.[0-9]\+')"

if ! docker build -t "$IMAGE_NAME:$IMAGE_TAG" -f "$DOCKERFILE" --build-arg CONFIG_DIR="$CONFIG_DIR" .; then
    echo "Error: Docker image build failed."
    exit 1
fi

echo "Docker image $IMAGE_NAME:$IMAGE_TAG built successfully!"
echo ""
echo "To run the container:"
echo "  docker run -d \\"
echo "    -p 8001:8001 \\"
echo "    -v \$(pwd)/server:/opt/canvas-server/data/server \\"
echo "    -v \$(pwd)/users:/opt/canvas-server/data/users \\"
echo "    --name canvas-server \\"
echo "    $IMAGE_NAME:$IMAGE_TAG"
