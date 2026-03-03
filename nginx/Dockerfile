FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
# TLS cert/key are mounted at runtime via docker-compose volume bind-mount:
#   ./tls/cert.pem -> /etc/nginx/tls/cert.pem
#   ./tls/key.pem  -> /etc/nginx/tls/key.pem
