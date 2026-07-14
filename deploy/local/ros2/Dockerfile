ARG ROS_DISTRO=humble
ARG ROS_BASE_IMAGE=ros:${ROS_DISTRO}-ros-base
FROM ${ROS_BASE_IMAGE}

ARG DEBIAN_FRONTEND=noninteractive
ARG USERNAME=ros
ARG USER_UID=1000
ARG USER_GID=1000
ARG GO_VERSION=1.25.5
ARG INSTALL_GOLANG=0
ARG GOPROXY=https://goproxy.cn,direct
ARG GOSUMDB=sum.golang.google.cn
ARG TARGETARCH
ARG ENABLE_VISION_STACK=0
ARG VISION_TARGET=none
ARG ONNX_VERSION=1.16.2

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash-completion \
    autoconf \
    automake \
    build-essential \
    ca-certificates \
    cyclonedds-dev \
    cyclonedds-tools \
    cmake \
    curl \
    git \
    libasound2-dev \
    libprotobuf-dev \
    libtool \
    libyaml-cpp-dev \
    pkg-config \
    protobuf-compiler \
    python3-colcon-common-extensions \
    python3-pip \
    python3-rosdep \
    python3-vcstool \
    ros-${ROS_DISTRO}-fastcdr \
    ros-${ROS_DISTRO}-fastrtps \
    ros-${ROS_DISTRO}-rmw-cyclonedds-cpp \
    ros-${ROS_DISTRO}-rmw-fastrtps-cpp \
    ros-${ROS_DISTRO}-ruckig \
    sudo \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  case "${INSTALL_GOLANG}" in \
    1|true|TRUE|yes|YES|on|ON) ;; \
    *) echo "Skipping Go native dependencies (INSTALL_GOLANG=${INSTALL_GOLANG})"; exit 0 ;; \
  esac; \
  apt-get update; \
  apt-get install -y --no-install-recommends libasound2-dev; \
  rm -rf /var/lib/apt/lists/*

ARG GO_DOWNLOAD_BASE=https://dl.google.com/go
RUN set -eux; \
  case "${INSTALL_GOLANG}" in \
    1|true|TRUE|yes|YES|on|ON) ;; \
    *) echo "Skipping Go install (INSTALL_GOLANG=${INSTALL_GOLANG})"; exit 0 ;; \
  esac; \
  go_arch="${TARGETARCH:-amd64}"; \
  case "${go_arch}" in \
    amd64|arm64) ;; \
    *) echo "unsupported Go architecture: ${go_arch}" >&2; exit 1 ;; \
  esac; \
  go_url="${GO_DOWNLOAD_BASE%/}/go${GO_VERSION}.linux-${go_arch}.tar.gz"; \
  curl -fL --retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 30 --max-time 1800 "${go_url}" -o /tmp/go.tgz; \
  rm -rf /usr/local/go; \
  tar -C /usr/local -xzf /tmp/go.tgz; \
  rm -f /tmp/go.tgz; \
  ln -sf /usr/local/go/bin/go /usr/local/bin/go; \
  ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt

COPY infra/otel/python/requirements.txt /tmp/pacific-rim-otel-requirements.txt
RUN set -eux; \
  pip_args=(--no-cache-dir); \
  if python3 -m pip install --help | grep -q -- "--break-system-packages"; then \
    pip_args+=(--break-system-packages); \
  fi; \
  python3 -m pip install "${pip_args[@]}" \
    -r /tmp/pacific-rim-otel-requirements.txt \
  && rm -f /tmp/pacific-rim-otel-requirements.txt

COPY infra/communication/python/requirements.txt /tmp/pacific-rim-communication-requirements.txt
RUN set -eux; \
  pip_args=(--no-cache-dir); \
  if python3 -m pip install --help | grep -q -- "--break-system-packages"; then \
    pip_args+=(--break-system-packages); \
  fi; \
  python3 -m pip install "${pip_args[@]}" \
    -r /tmp/pacific-rim-communication-requirements.txt \
  && rm -f /tmp/pacific-rim-communication-requirements.txt

COPY deploy/ros2/python-runtime-requirements.txt /tmp/pacific-rim-python-runtime-requirements.txt
RUN set -eux; \
  pip_args=(--no-cache-dir); \
  if python3 -m pip install --help | grep -q -- "--break-system-packages"; then \
    pip_args+=(--break-system-packages); \
  fi; \
  python3 -m pip install "${pip_args[@]}" \
    -r /tmp/pacific-rim-python-runtime-requirements.txt \
  && rm -f /tmp/pacific-rim-python-runtime-requirements.txt

COPY deploy/ros2/install-vision-stack.sh /tmp/pacific-rim-install-vision-stack.sh
RUN ROS_DISTRO="${ROS_DISTRO}" \
    ENABLE_VISION_STACK="${ENABLE_VISION_STACK}" \
    VISION_TARGET="${VISION_TARGET}" \
    ONNX_VERSION="${ONNX_VERSION}" \
    TARGETARCH="${TARGETARCH}" \
    bash /tmp/pacific-rim-install-vision-stack.sh \
  && rm -f /tmp/pacific-rim-install-vision-stack.sh

RUN if ! id -u "${USERNAME}" >/dev/null 2>&1; then \
    EXISTING_USER="$(getent passwd "${USER_UID}" | cut -d: -f1 || true)" \
    && if [ "${USER_UID}" = "0" ]; then \
      EXISTING_GROUP="$(getent group "${USER_GID}" | cut -d: -f1 || true)" \
      && if [ -z "${EXISTING_GROUP}" ]; then \
        groupadd --gid "${USER_GID}" "${USERNAME}" \
        && EXISTING_GROUP="${USERNAME}"; \
      fi \
      && useradd --uid "${USER_UID}" --gid "${EXISTING_GROUP}" --non-unique -m "${USERNAME}"; \
    elif [ -n "${EXISTING_USER}" ]; then \
      usermod -l "${USERNAME}" "${EXISTING_USER}" \
      && usermod -d "/home/${USERNAME}" -m "${USERNAME}"; \
    else \
      EXISTING_GROUP="$(getent group "${USER_GID}" | cut -d: -f1 || true)" \
      && if [ -z "${EXISTING_GROUP}" ]; then \
        groupadd --gid "${USER_GID}" "${USERNAME}" \
        && EXISTING_GROUP="${USERNAME}"; \
      fi \
      && useradd --uid "${USER_UID}" --gid "${EXISTING_GROUP}" -m "${USERNAME}"; \
    fi; \
  fi \
  && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/${USERNAME}" \
  && chmod 0440 "/etc/sudoers.d/${USERNAME}"

RUN rosdep init 2>/dev/null || true

USER ${USERNAME}
WORKDIR /workspace

RUN echo "source /opt/ros/${ROS_DISTRO}/setup.bash" >> "/home/${USERNAME}/.bashrc"

ENV ROS_DISTRO=${ROS_DISTRO}
ENV ROS_ROOT=/opt/ros/${ROS_DISTRO}
ENV COLCON_HOME=/workspace/.cache/colcon
ENV ENABLE_VISION_STACK=${ENABLE_VISION_STACK}
ENV VISION_TARGET=${VISION_TARGET}
ENV ONNX_VERSION=${ONNX_VERSION}
ENV INSTALL_GOLANG=${INSTALL_GOLANG}
ENV GOPROXY=${GOPROXY}
ENV GOSUMDB=${GOSUMDB}
ENV PATH=/usr/local/go/bin:${PATH}

CMD ["bash"]
