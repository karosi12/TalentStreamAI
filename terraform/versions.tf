terraform {
  # S3 native state locking (use_lockfile) needs Terraform 1.11+.
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    # bucket, key, region: pass via -backend-config or backend.hcl
    encrypt      = true
    use_lockfile = true
  }
}
