data "aws_caller_identity" "current" {}

data "external" "lambda_package_size" {
  program = ["bash", "${path.root}/check_lambda_size.sh"]

  query = {
    file_path = abspath("${path.root}/../backend/lambda-deployment.zip")
  }
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  use_s3_object   = data.external.lambda_package_size.result.use_s3 == "true"
  lambda_zip_path = abspath("${path.root}/../backend/lambda-deployment.zip")
}

module "s3_resume" {
  source = "./modules/s3_resume"

  name_prefix = local.name_prefix
  account_id  = data.aws_caller_identity.current.account_id
  tags        = local.common_tags
}

module "s3_frontend" {
  source = "./modules/s3_frontend"

  name_prefix = local.name_prefix
  account_id  = data.aws_caller_identity.current.account_id
  tags        = local.common_tags
}

module "cdn" {
  source = "./modules/cdn"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name_prefix               = local.name_prefix
  tags                      = local.common_tags
  use_custom_domain         = var.use_custom_domain
  root_domain               = var.root_domain
  frontend_website_endpoint = module.s3_frontend.website_endpoint
  frontend_bucket_id        = module.s3_frontend.bucket_id
}

module "api" {
  source = "./modules/api"

  depends_on = [module.cdn]

  name_prefix = local.name_prefix
  tags        = local.common_tags

  resume_bucket_id = module.s3_resume.bucket_id

  use_custom_domain         = var.use_custom_domain
  root_domain               = var.root_domain
  cloudfront_domain_name    = module.cdn.distribution_domain_name
  use_s3_object_for_package = local.use_s3_object
  lambda_artifacts_bucket   = "${local.name_prefix}-${data.aws_caller_identity.current.account_id}"
  lambda_zip_path           = local.lambda_zip_path

  lambda_timeout           = var.lambda_timeout
  memory_size              = var.memory_size
  api_throttle_burst_limit = var.api_throttle_burst_limit
  api_throttle_rate_limit  = var.api_throttle_rate_limit

  openai_api_key = var.openai_api_key
  clerk_jwks_url = var.clerk_jwks_url
  clerk_issuer   = var.clerk_issuer
  agent_mode     = var.agent_mode
  llm_base_url   = var.llm_base_url

  upload_storage = var.upload_storage
  s3_prefix      = var.s3_prefix
  s3_sse         = var.s3_sse
}
