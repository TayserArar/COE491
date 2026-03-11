FROM eclipse-mosquitto:2.0

COPY config/mosquitto.conf /mosquitto/custom/mosquitto.conf
COPY config/acl /mosquitto/custom/acl
COPY entrypoint.sh /entrypoint.sh

RUN mkdir -p /mosquitto/custom \
    && chown -R mosquitto:mosquitto /mosquitto/custom \
    && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
