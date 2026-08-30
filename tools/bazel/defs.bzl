"""Small build macros shared by Meshr's root and image packages."""

def node_bundle(js_run_binary, name, entry_point, srcs, tool):
    js_run_binary(
        name = name,
        srcs = srcs,
        args = [
            entry_point,
            "../../../$@",
        ],
        chdir = native.package_name(),
        outs = [name + ".mjs"],
        tool = tool,
    )

def meshr_image(oci_image, name, base, architecture, tars, default_args, entrypoint = None):
    oci_image(
        name = name,
        base = base,
        cmd = default_args,
        entrypoint = entrypoint or ["/nodejs/bin/node"],
        env = {"NODE_ENV": "production"},
        labels = {
            "org.opencontainers.image.source": "https://github.com/tflynn3/meshr",
            "org.opencontainers.image.title": "Meshr {}".format(name),
        },
        tars = tars,
        user = "65532:65532",
        workdir = "/app",
    )

def meshr_images(oci_image, oci_image_index, oci_load):
    for arch, base, architecture in [
        ("arm64", "@distroless_node_linux_arm64_v8", "arm64"),
        ("amd64", "@distroless_node_linux_amd64", "amd64"),
    ]:
        meshr_image(
            oci_image = oci_image,
            name = "api_{}".format(arch),
            architecture = architecture,
            base = base,
            default_args = ["/app/api_bin.runfiles/_main/api.mjs"],
            tars = ["//:api_{}_layers".format(arch)],
        )
        meshr_image(
            oci_image = oci_image,
            name = "event_plane_{}".format(arch),
            architecture = architecture,
            base = base,
            default_args = ["ingest"],
            entrypoint = [
                "/nodejs/bin/node",
                "/app/event_plane_bin.runfiles/_main/event_plane.mjs",
            ],
            tars = ["//:event_plane_{}_layers".format(arch)],
        )
        meshr_image(
            oci_image = oci_image,
            name = "web_{}".format(arch),
            architecture = architecture,
            base = base,
            default_args = ["/app/static_server.mjs"],
            tars = [
                ":web_server_layer",
                ":web_assets_layer",
            ],
        )

        for image_name in ["api", "event_plane", "web"]:
            oci_load(
                name = "{}_{}_load".format(image_name, arch),
                format = "docker",
                image = ":{}_{}".format(image_name, arch),
                repo_tags = ["meshr-{}:dev".format(image_name.replace("_", "-"))],
            )
            native.filegroup(
                name = "{}_{}_archive".format(image_name, arch),
                srcs = [":{}_{}_load".format(image_name, arch)],
                output_group = "tarball",
            )

    for image_name in ["api", "event_plane", "web"]:
        oci_image_index(
            name = "{}_index".format(image_name),
            images = [
                ":{}_amd64".format(image_name),
                ":{}_arm64".format(image_name),
            ],
        )
