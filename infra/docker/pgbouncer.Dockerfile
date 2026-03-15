FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends pgbouncer ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY infra/pgbouncer/pgbouncer.ini /etc/pgbouncer/pgbouncer.ini

USER postgres

EXPOSE 6432

CMD ["pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]
