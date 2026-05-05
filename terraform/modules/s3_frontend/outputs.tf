output "bucket_id" {
  description = "Frontend static site S3 bucket name"
  value       = aws_s3_bucket.frontend.id
}

output "bucket_arn" {
  description = "Frontend S3 bucket ARN"
  value       = aws_s3_bucket.frontend.arn
}

output "website_endpoint" {
  description = "S3 website endpoint hostname for CloudFront origin"
  value       = aws_s3_bucket_website_configuration.frontend.website_endpoint
}
