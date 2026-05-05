locals {
  lambda_s3_key = "lambda-deployment.zip"

  s3_object_exists = var.use_s3_object_for_package && length(data.aws_s3_object.lambda_zip) > 0

  cors_origins = var.use_custom_domain && var.root_domain != "" ? "https://${var.root_domain},https://www.${var.root_domain}" : "https://${var.cloudfront_domain_name}"
}

data "aws_s3_object" "lambda_zip" {
  count = var.use_s3_object_for_package ? 1 : 0

  bucket = var.lambda_artifacts_bucket
  key    = local.lambda_s3_key
}

resource "aws_iam_role" "lambda_role" {
  name = "${var.name_prefix}-lambda-role"
  tags = var.tags

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

resource "aws_lambda_function" "api" {
  function_name = "${var.name_prefix}-api"
  role          = aws_iam_role.lambda_role.arn
  handler       = "app.main.handler"

  filename  = local.s3_object_exists ? null : var.lambda_zip_path
  s3_bucket = local.s3_object_exists ? var.lambda_artifacts_bucket : null
  s3_key    = local.s3_object_exists ? local.lambda_s3_key : null

  source_code_hash = filebase64sha256(var.lambda_zip_path)

  runtime       = "python3.12"
  architectures = ["x86_64"]
  timeout       = var.lambda_timeout
  tags          = var.tags
  memory_size   = var.memory_size

  lifecycle {
    ignore_changes = []
  }

  environment {
    variables = {
      CORS_ORIGINS   = local.cors_origins
      S3_BUCKET      = var.resume_bucket_id
      USE_S3         = tostring(var.use_s3_object_for_package)
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
}

resource "aws_apigatewayv2_api" "main" {
  name          = "${var.name_prefix}-api-gateway"
  protocol_type = "HTTP"
  tags          = var.tags

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
  tags        = var.tags

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

resource "aws_apigatewayv2_route" "get_root" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

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

resource "aws_apigatewayv2_route" "get_auth_me" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /api/v1/auth/me"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "get_dashboard" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /api/v1/dashboard/stats"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

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

resource "aws_apigatewayv2_route" "post_applications_stream" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /api/v1/applications/tailor/stream"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

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

resource "aws_lambda_permission" "api_gw" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}
