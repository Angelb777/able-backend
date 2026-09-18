FROM ghcr.io/valhalla/valhalla-scripted:3.8.3
USER root
RUN apt-get update && apt-get install -y --no-install-recommends osmium-tool \
    && rm -rf /var/lib/apt/lists/*
COPY prepare_regions.py /opt/able/prepare_regions.py
ENV path_extension=es-panama-v1 \
    use_tiles_ignore_pbf=False \
    force_rebuild=False \
    server_threads=2
ENTRYPOINT ["python3", "/opt/able/prepare_regions.py"]
CMD ["build_tiles"]
