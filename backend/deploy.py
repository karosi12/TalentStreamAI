import os
import shutil
import stat
import subprocess
import zipfile
import boto3
from dotenv import load_dotenv

load_dotenv(override=True)  # Load environment variables from .env file, allowing overrides

def _rmtree_onexc(func, path, exc: BaseException) -> None:
    """Widen perms then retry (read-only dirs, etc.). Root-owned files: delete with sudo once or fix Docker -u."""
    try:
        os.chmod(path, stat.S_IRWXU | stat.S_IRWXG | stat.S_IRWXO)
        func(path)
    except OSError:
        raise exc


def safe_rmtree(path: str) -> None:
    if os.path.isdir(path):
        shutil.rmtree(path, onexc=_rmtree_onexc)

def ensure_bucket_exists(s3, bucket_name):
    buckets = [b['Name'] for b in s3.list_buckets()['Buckets']]
    if bucket_name not in buckets:
        print(f"Creating bucket: {bucket_name}")
        s3.create_bucket(Bucket=bucket_name)

def main():
    print("Creating Lambda deployment package...")

    # Clean up (Docker may leave root-owned files in lambda-package; chmod+retry helps)
    if os.path.exists("lambda-package"):
        safe_rmtree("lambda-package")
    if os.path.exists("lambda-deployment.zip"):
        os.remove("lambda-deployment.zip")

    # Create package directory
    os.makedirs("lambda-package")

    # Install dependencies using Docker with Lambda runtime image
    print("Installing dependencies for Lambda runtime...")

    # Use the official AWS Lambda Python 3.12 image
    # This ensures compatibility with Lambda's runtime environment
    subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "-u",
            f"{os.getuid()}:{os.getgid()}",
            "-v",
            f"{os.getcwd()}:/var/task",
            "--platform",
            "linux/amd64",  # Force x86_64 architecture
            "--entrypoint",
            "",  # Override the default entrypoint
            "public.ecr.aws/lambda/python:3.12",
            "/bin/sh",
            "-c",
            "pip install --target /var/task/lambda-package -r /var/task/requirements.txt --platform manylinux2014_x86_64 --only-binary=:all: --upgrade",
        ],
        check=True,
    )

    # Copy application files from app directory
    print("Copying application files...")
    # Copy the entire app directory
    if os.path.exists("app"):
        shutil.copytree("app", "lambda-package/app")
    else:
        print("Warning: app directory not found")
    
    # Copy data directory if it exists (.data directory)
    if os.path.exists(".data"):
        shutil.copytree(".data", "lambda-package/data")

    # Create zip
    print("Creating zip file...")
    with zipfile.ZipFile("lambda-deployment.zip", "w", zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk("lambda-package"):
            for file in files:
                file_path = os.path.join(root, file)
                arcname = os.path.relpath(file_path, "lambda-package")
                zipf.write(file_path, arcname)

    # Show package size
    size_mb = os.path.getsize("lambda-deployment.zip") / (1024 * 1024)
    print(f"✓ Created lambda-deployment.zip ({size_mb:.2f} MB)")
    ZIP_FILE = "lambda-deployment.zip"

    # You can pass these dynamically if needed
    project_name = os.getenv("PROJECT_NAME", "talentstreamai")
    environment = os.getenv("ENVIRONMENT", "dev")
    account_id = os.getenv("AWS_ACCOUNT_ID", "123456789012")

    bucket_name = f"{project_name}-{environment}-{account_id}"
    s3_key = "lambda-deployment.zip"

    if size_mb > 50:
        print("⚠️ Package exceeds 50 MB. Uploading to S3...")

        s3 = boto3.client("s3")
        ensure_bucket_exists(s3, bucket_name)
        try:
            s3.upload_file(
                ZIP_FILE,
                bucket_name,
                s3_key
            )
            print(f"✓ Uploaded to s3://{bucket_name}/{s3_key}")
            print("👉 Use this S3 location in your Lambda/Terraform deployment")

        except Exception as e:
            print(f"❌ Failed to upload to S3: {e}")
            raise

    else:
        print("✓ Package size is within AWS Lambda limits.")
        print("👉 You can deploy directly using the zip file")

if __name__ == "__main__":
    main()