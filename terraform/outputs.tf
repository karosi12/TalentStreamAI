output "api_gateway_url" {
  description = "URL of the API Gateway"
  value       = module.api.api_gateway_url
}

output "cloudfront_url" {
  description = "URL of the CloudFront distribution"
  value       = "https://${module.cdn.distribution_domain_name}"
}

output "s3_frontend_bucket" {
  description = "Name of the S3 bucket for frontend"
  value       = module.s3_frontend.bucket_id
}

output "s3_resume_storage_bucket" {
  description = "Name of the S3 bucket for resume storage"
  value       = module.s3_resume.bucket_id
}

output "lambda_function_name" {
  description = "Name of the Lambda function"
  value       = module.api.lambda_function_name
}

output "custom_domain_url" {
  description = "Root URL of the production site"
  value       = var.use_custom_domain ? "https://${var.root_domain}" : ""
}
