FROM alpine:3.19

# Install OpenSSH server and required tools
RUN apk add --no-cache \
    openssh-server \
    bash \
    shadow \
    netcat-openbsd

# Create necessary directories
RUN mkdir -p /var/run/sshd /config

# Generate host keys
RUN ssh-keygen -A

# Copy SSH daemon configuration
COPY sshd_config /etc/ssh/sshd_config

# Copy entrypoint script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Expose SSH port
EXPOSE 22

# Set entrypoint
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
