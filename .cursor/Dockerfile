FROM node:22-bullseye

# Install system dependencies for LMDB and development tools
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    python3-pip \
    git \
    curl \
    wget \
    vim \
    nano \
    htop \
    tree \
    jq \
    liblmdb-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Install global Node.js development tools
RUN npm install -g \
    nodemon \
    pm2 \
    typescript \
    ts-node \
    eslint \
    prettier

# Create a non-root user for development
RUN useradd -m -s /bin/bash ubuntu && \
    usermod -aG sudo ubuntu && \
    echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# Set up the working directory
USER ubuntu
WORKDIR /home/ubuntu

# Set environment variables
ENV NODE_ENV=development
ENV PATH="/home/ubuntu/.local/bin:${PATH}"

# Create common directories
RUN mkdir -p /home/ubuntu/.npm-global && \
    mkdir -p /home/ubuntu/.cache && \
    mkdir -p /home/ubuntu/workspace

# Configure npm to use the global directory
RUN npm config set prefix '/home/ubuntu/.npm-global'
ENV PATH="/home/ubuntu/.npm-global/bin:${PATH}"

# Set the default shell to bash
SHELL ["/bin/bash", "-c"]
