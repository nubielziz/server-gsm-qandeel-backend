# Backup tools image (feature 24D, decision 036): pg_dump/pg_restore of the same major as the server, rclone and age.
# Build from the repository root:  docker build -t gsm-backup:<tag> -f deploy/backup/Dockerfile .
# The host's cron or systemd timer runs it through `docker compose run --rm backup <script>` (docs/OPERATIONS.md).
FROM postgres:18.6-trixie

RUN apt-get update \
 && apt-get install --yes --no-install-recommends rclone age ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY scripts/backup/ /opt/backup/
RUN chmod 0755 /opt/backup/*.sh \
 && useradd --system --create-home --uid 10001 gsmbackup
ENV PATH="/opt/backup:${PATH}"
USER gsmbackup
WORKDIR /home/gsmbackup
# No entrypoint: the compose service passes the script name as the command. The base image's entrypoint would start a server.
ENTRYPOINT []
CMD ["pg-backup.sh"]
