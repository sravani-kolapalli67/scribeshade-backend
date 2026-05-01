#!/bin/bash

# ==============================================================================
# Deployment Configuration
# ==============================================================================
IMAGE_NAME="scribeshade-backend"
IMAGE_TAG="latest"
TAR_NAME="scribeshade-backend.tar"

SERVER_USER="root"
SERVER_IP="31.97.237.184"
# Change this if your path is literally "/scribeshade" instead of "~/scribeshade"
REMOTE_DIR="~/scribeshade"

echo "=========================================================="
echo " Starting Deployment Process"
echo "=========================================================="

# 1. Optionally copy .env to the server
if [ "$COPY_ENV" = "true" ] || [ "$COPY_ENV" = "1" ]; then
    echo "=> COPY_ENV flag detected."
    # Change ".env" below to ".env.docker" if that's your local target file
    LOCAL_ENV_FILE=".env" 
    
    if [ -f "$LOCAL_ENV_FILE" ]; then
        echo "=> Uploading $LOCAL_ENV_FILE to server as .env..."
        scp "$LOCAL_ENV_FILE" "${SERVER_USER}@${SERVER_IP}:${REMOTE_DIR}/.env"
    else
        echo "=> WARNING: $LOCAL_ENV_FILE not found locally. Skipping env copy."
    fi
fi

# 2. Build the Docker image locally for linux/amd64 (server architecture)
echo "=> Ensuring buildx builder with cross-platform support exists..."
docker buildx inspect scribeshade-builder > /dev/null 2>&1 || \
    docker buildx create --name scribeshade-builder --driver docker-container --bootstrap
docker buildx use scribeshade-builder

echo "=> Building Docker image (${IMAGE_NAME}:${IMAGE_TAG}) for linux/amd64..."
docker buildx build \
    --platform linux/amd64 \
    --load \
    -t ${IMAGE_NAME}:${IMAGE_TAG} \
    .
if [ $? -ne 0 ]; then
    echo "=> ERROR: Docker build failed. Aborting."
    exit 1
fi

# 3. Save the image to a tar file so it can be copied without a registry
echo "=> Saving Docker image to ${TAR_NAME}..."
docker save -o ${TAR_NAME} ${IMAGE_NAME}:${IMAGE_TAG}
if [ $? -ne 0 ]; then
    echo "=> ERROR: Failed to save Docker image. Aborting."
    exit 1
fi

# 4. Upload the tar file to the server using SCP
echo "=> Uploading ${TAR_NAME} to the server (${SERVER_USER}@${SERVER_IP})..."
echo "(You may be prompted for your SSH password)"
scp ${TAR_NAME} ${SERVER_USER}@${SERVER_IP}:${REMOTE_DIR}/${TAR_NAME}
if [ $? -ne 0 ]; then
    echo "=> ERROR: Upload failed. Aborting."
    rm -f ${TAR_NAME}
    exit 1
fi

# 5. SSH into the server, load the image, and restart the container
echo "=> Connecting to server to load image and restart container..."
echo "(You may be prompted for your SSH password again)"
ssh ${SERVER_USER}@${SERVER_IP} << EOF
    echo "=> Navigating to ${REMOTE_DIR}..."
    cd ${REMOTE_DIR} || { echo "Directory not found!"; exit 1; }
    
    echo "=> Loading Docker image from tar archive..."
    docker load -i ${TAR_NAME}
    
    echo "=> Restarting container with docker compose..."
    # Ensure it picks up any new .env changes if they were copied
    mkdir -p uploads/documents
    chmod -R 777 uploads
    docker compose down
    docker compose up -d
    
    echo "=> Cleaning up remote tar file..."
    rm -f ${TAR_NAME}
    
    echo "=> Remote deployment steps complete!"
EOF

# 6. Clean up the local tar file
echo "=> Cleaning up local ${TAR_NAME}..."
rm -f ${TAR_NAME}

echo "=========================================================="
echo " Deployment Successfully Finished!"
echo "=========================================================="
