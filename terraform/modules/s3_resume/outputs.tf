output "bucket_id" {
  description = "Resume storage S3 bucket name"
  value       = aws_s3_bucket.resume_storage.id
}

output "bucket_arn" {
  description = "Resume storage S3 bucket ARN"
  value       = aws_s3_bucket.resume_storage.arn
}
