# Serves the exported dashboard (npm run export -> dashboard/site) as a static website.
# Build from the project root:  docker build -f hosting/Dockerfile -t funnel-monitor-site .
FROM nginx:1.27-alpine
COPY hosting/nginx.conf /etc/nginx/conf.d/default.conf
COPY dashboard/site/ /usr/share/nginx/html/
# runs as the unprivileged nginx user on a high port; put HTTPS and sign-in in front (see hosting/HOSTING.md)
EXPOSE 8080
USER nginx
