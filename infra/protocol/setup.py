from setuptools import find_namespace_packages, setup

setup(
    name="pacific_rim_protocol_infra",
    version="0.1.0",
    package_dir={"": "python"},
    packages=find_namespace_packages(where="python"),
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/pacific_rim_protocol_infra"]),
        ("share/pacific_rim_protocol_infra", ["package.xml"]),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="Pacific-Rim Developers",
    maintainer_email="dev@example.com",
    description="Transport-neutral protocol codecs and schema helpers for Pacific-Rim modules.",
    license="Apache-2.0",
)
