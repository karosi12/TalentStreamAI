# Data source to get current AWS account ID
data "aws_caller_identity" "current" {}

# Check Lambda deployment package size to determine if we need to use S3
data "external" "lambda_package_size" {
  program = ["bash", "${path.module}/check_lambda_size.sh"]
}

locals {
  aliases = var.use_custom_domain && var.root_domain != "" ? [
    var.root_domain,
    "www.${var.root_domain}"
  ] : []

  name_prefix = "${var.project_name}-${var.environment}"

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# S3 bucket for resume storage
resource "aws_s3_bucket" "resume_storage" {
  bucket = "${local.name_prefix}-resume-${data.aws_caller_identity.current.account_id}"
  tags   = local.common_tags

}

resource "aws_s3_bucket_public_access_block" "resume_storage" {
  bucket = aws_s3_bucket.resume_storage.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "resume_storage" {
  bucket = aws_s3_bucket.resume_storage.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Ensure uploads/ folder exists in the resume storage bucket
resource "aws_s3_object" "resume_uploads_folder" {
  bucket = aws_s3_bucket.resume_storage.id
  key    = "uploads/"
  acl    = "private"
}

# S3 bucket for frontend static website
resource "aws_s3_bucket" "frontend" {
  bucket = "${local.name_prefix}-frontend-${data.aws_caller_identity.current.account_id}"
  tags   = local.common_tags
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_website_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "404.html"
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadGetObject"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.frontend.arn}/*"
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.frontend]
}

# IAM role for Lambda
resource "aws_iam_role" "lambda_role" {
  name = "${local.name_prefix}-lambda-role"
  tags = local.common_tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
  role       = aws_iam_role.lambda_role.name
}

resource "aws_iam_role_policy_attachment" "lambda_s3" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonS3FullAccess"
  role       = aws_iam_role.lambda_role.name
}

locals {
  lambda_s3_key = "lambda-deployment.zip"
  lambda_bucket = "${local.name_prefix}-${data.aws_caller_identity.current.account_id}"

  use_s3_object = data.external.lambda_package_size.result.use_s3 == "true" ? true : false
}

locals {
  s3_object_exists = local.use_s3_object && length(data.aws_s3_object.lambda_zip) > 0
}

data "aws_s3_object" "lambda_zip" {
  count = local.use_s3_object ? 1 : 0

  bucket = local.lambda_bucket
  key    = local.lambda_s3_key
}

# Lambda function
resource "aws_lambda_function" "api" {
  function_name = "${local.name_prefix}-api"
  role          = aws_iam_role.lambda_role.arn
  handler       = "app.main.handler"

  # Conditional S3 vs local file
  filename  = local.s3_object_exists ? null : "${path.module}/../backend/lambda-deployment.zip"
  s3_bucket = local.s3_object_exists ? local.lambda_bucket : null
  s3_key    = local.s3_object_exists ? local.lambda_s3_key : null

  source_code_hash = filebase64sha256("${path.module}/../backend/lambda-deployment.zip")

  runtime       = "python3.12"
  architectures = ["x86_64"]
  timeout       = var.lambda_timeout
  tags          = local.common_tags
  memory_size   = var.memory_size

  lifecycle {
    ignore_changes = []
  }

  environment {
    variables = {
      CORS_ORIGINS   = var.use_custom_domain ? "https://${var.root_domain},https://www.${var.root_domain}" : "https://${aws_cloudfront_distribution.main.domain_name}"
      S3_BUCKET      = aws_s3_bucket.resume_storage.id
      USE_S3         = tostring(local.use_s3_object)
      OPENAI_API_KEY = var.openai_api_key
      CLERK_JWKS_URL = var.clerk_jwks_url
      CLERK_ISSUER   = var.clerk_issuer
      AGENT_MODE     = var.agent_mode
      LLM_BASE_URL   = var.llm_base_url
      S3_PREFIX      = var.s3_prefix
      S3_SSE         = var.s3_sse
      UPLOAD_STORAGE = var.upload_storage
    }
  }

  depends_on = [
    aws_cloudfront_distribution.main,
    aws_s3_bucket.resume_storage
  ]
}

resource "aws_lambda_alias" "live" {
  name             = "live"
  function_name    = aws_lambda_function.api.function_name
  function_version = "$LATEST"
}

resource "aws_lambda_provisioned_concurrency_config" "api_pc" {
  function_name                     = aws_lambda_function.api.function_name
  qualifier                         = aws_lambda_alias.live.name
  provisioned_concurrent_executions = 10
}

# API Gateway HTTP API
resource "aws_apigatewayv2_api" "main" {
  name          = "${local.name_prefix}-api-gateway"
  protocol_type = "HTTP"
  tags          = local.common_tags

  cors_configuration {
    allow_credentials = false
    allow_headers     = ["*"]
    allow_methods     = ["GET", "POST", "OPTIONS", "PATCH"]
    allow_origins     = ["*"]
    max_age           = 300
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true
  tags        = local.common_tags

  default_route_settings {
    throttling_burst_limit = var.api_throttle_burst_limit
    throttling_rate_limit  = var.api_throttle_rate_limit
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.api.invoke_arn
}

# API Gateway Routes
resource "aws_apigatewayv2_route" "get_root" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

#profile routes
resource "aws_apigatewayv2_route" "get_profile" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /api/v1/profile"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}
resource "aws_apigatewayv2_route" "patch_profile" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "PATCH /api/v1/profile"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "post_profile_base_resume" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /api/v1/profile/base-resume"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

# heath check routes
resource "aws_apigatewayv2_route" "get_health" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /api/v1/health"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}
resource "aws_apigatewayv2_route" "get_ready" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /api/v1/ready"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

#auth route
resource "aws_apigatewayv2_route" "get_auth_me" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /api/v1/auth/me"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

#dashboard route
resource "aws_apigatewayv2_route" "get_dashboard" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /api/v1/dashboard/stats"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

#applications routes
resource "aws_apigatewayv2_route" "get_applications" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /api/v1/applications"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}
resource "aws_apigatewayv2_route" "get_one_application" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /api/v1/applications/{application_id}"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}
resource "aws_apigatewayv2_route" "post_applications" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /api/v1/applications/tailor"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

#resume routes
resource "aws_apigatewayv2_route" "get_resumes" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /api/v1/resumes"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "post_resumes" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /api/v1/resumes"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "get_one_resume" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /api/v1/resumes/{resume_id}"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

#job description routes
resource "aws_apigatewayv2_route" "post_job_descriptions" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /api/v1/job-descriptions"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "get_job_descriptions" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /api/v1/job-descriptions/{job_description_id}"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

# generation
resource "aws_apigatewayv2_route" "post_generation" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /api/v1/generate/stream"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}
resource "aws_apigatewayv2_route" "post_generate_missing_skills" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /api/v1/generate/with-missing-skills"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

# Lambda permission for API Gateway
resource "aws_lambda_permission" "api_gw" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# CloudFront distribution
resource "aws_cloudfront_distribution" "main" {
  aliases = local.aliases

  viewer_certificate {
    acm_certificate_arn            = var.use_custom_domain ? aws_acm_certificate.site[0].arn : null
    cloudfront_default_certificate = var.use_custom_domain ? false : true
    ssl_support_method             = var.use_custom_domain ? "sni-only" : null
    minimum_protocol_version       = "TLSv1.2_2021"
  }

  origin {
    domain_name = aws_s3_bucket_website_configuration.frontend.website_endpoint
    origin_id   = "S3-${aws_s3_bucket.frontend.id}"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  tags                = local.common_tags

  default_cache_behavior {
    allowed_methods  = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-${aws_s3_bucket.frontend.id}"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }
}

# Optional: Custom domain configuration (only created when use_custom_domain = true)
data "aws_route53_zone" "root" {
  count        = var.use_custom_domain ? 1 : 0
  name         = var.root_domain
  private_zone = false
}

resource "aws_acm_certificate" "site" {
  count                     = var.use_custom_domain ? 1 : 0
  provider                  = aws.us_east_1
  domain_name               = var.root_domain
  subject_alternative_names = ["www.${var.root_domain}"]
  validation_method         = "DNS"
  lifecycle { create_before_destroy = true }
  tags = local.common_tags
}

resource "aws_route53_record" "site_validation" {
  for_each = var.use_custom_domain ? {
    for dvo in aws_acm_certificate.site[0].domain_validation_options :
    dvo.domain_name => dvo
  } : {}

  zone_id = data.aws_route53_zone.root[0].zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  ttl     = 300
  records = [each.value.resource_record_value]
}

resource "aws_acm_certificate_validation" "site" {
  count           = var.use_custom_domain ? 1 : 0
  provider        = aws.us_east_1
  certificate_arn = aws_acm_certificate.site[0].arn
  validation_record_fqdns = [
    for r in aws_route53_record.site_validation : r.fqdn
  ]
}

resource "aws_route53_record" "alias_root" {
  count   = var.use_custom_domain ? 1 : 0
  zone_id = data.aws_route53_zone.root[0].zone_id
  name    = var.root_domain
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "alias_root_ipv6" {
  count   = var.use_custom_domain ? 1 : 0
  zone_id = data.aws_route53_zone.root[0].zone_id
  name    = var.root_domain
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "alias_www" {
  count   = var.use_custom_domain ? 1 : 0
  zone_id = data.aws_route53_zone.root[0].zone_id
  name    = "www.${var.root_domain}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "alias_www_ipv6" {
  count   = var.use_custom_domain ? 1 : 0
  zone_id = data.aws_route53_zone.root[0].zone_id
  name    = "www.${var.root_domain}"
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}