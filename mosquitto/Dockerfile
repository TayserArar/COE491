FROM eclipse-mosquitto:2.0

COPY config/mosquitto.conf /mosquitto/custom/mosquitto.conf
COPY config/acl /mosquitto/custom/acl
COPY entrypoint.sh /entrypoint.sh

RUN apk add --no-cache openssl \
    && mkdir -p /mosquitto/custom /mosquitto/tls \
    && chown -R mosquitto:mosquitto /mosquitto/custom \
    && chmod 0640 /mosquitto/custom/mosquitto.conf \
    && chmod 0700 /mosquitto/custom/acl \
    && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
