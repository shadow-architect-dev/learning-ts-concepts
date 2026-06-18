FROM nginx:1.25.4-alpine
RUN apk update && apk upgrade --no-cache
COPY nginx.conf /etc/nginx/nginx.conf
COPY default.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
USER nginx
EXPOSE 8080
