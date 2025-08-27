FROM --platform=${BUILDPLATFORM} node:18 AS build

WORKDIR /opt/node_app

COPY . .

# do not ignore optional dependencies:
# Error: Cannot find module @rollup/rollup-linux-x64-gnu
RUN --mount=type=cache,target=/root/.cache/yarn \
    npm_config_target_arch=${TARGETARCH} yarn --network-timeout 600000

ARG NODE_ENV=development
ARG VITE_APP_BACKEND_V2_GET_URL
ARG VITE_APP_BACKEND_V2_POST_URL
ARG VITE_APP_LIBRARY_BACKEND
ARG VITE_APP_WS_SERVER_URL
ARG VITE_APP_FIREBASE_CONFIG

ENV NODE_ENV=$NODE_ENV \
    VITE_APP_BACKEND_V2_GET_URL=$VITE_APP_BACKEND_V2_GET_URL \
    VITE_APP_BACKEND_V2_POST_URL=$VITE_APP_BACKEND_V2_POST_URL \
    VITE_APP_LIBRARY_BACKEND=$VITE_APP_LIBRARY_BACKEND \
    VITE_APP_WS_SERVER_URL=$VITE_APP_WS_SERVER_URL \
    VITE_APP_FIREBASE_CONFIG="$VITE_APP_FIREBASE_CONFIG"

RUN npm_config_target_arch=${TARGETARCH} yarn build:app:docker

FROM --platform=${TARGETPLATFORM} nginx:1.27-alpine

COPY --from=build /opt/node_app/excalidraw-app/build /usr/share/nginx/html

HEALTHCHECK CMD wget -q -O /dev/null http://localhost || exit 1
