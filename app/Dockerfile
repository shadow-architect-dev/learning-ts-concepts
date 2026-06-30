FROM nginx:1.25.4-alpine
RUN apk update && apk upgrade --no-cache
COPY nginx.conf /etc/nginx/nginx.conf
COPY default.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY tetris/ /usr/share/nginx/html/tetris/
COPY othello/ /usr/share/nginx/html/othello/
COPY typing/ /usr/share/nginx/html/typing/
USER nginx
EXPOSE 8080
