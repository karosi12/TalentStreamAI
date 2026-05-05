variable "name_prefix" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "resume_bucket_id" {
  type        = string
  description = "S3 bucket for application uploads / resumes"
}

variable "use_custom_domain" {
  type    = bool
  default = false
}

variable "root_domain" {
  type    = string
  default = ""
}

variable "cloudfront_domain_name" {
  type        = string
  description = "CloudFront domain (no scheme) when not using a custom domain for CORS"
}

variable "use_s3_object_for_package" {
  type        = bool
  description = "Whether large deployment zip is loaded from S3"
}

variable "lambda_artifacts_bucket" {
  type        = string
  description = "Bucket name holding lambda-deployment.zip when use_s3_object_for_package"
}

variable "lambda_zip_path" {
  type        = string
  description = "Filesystem path to lambda zip for upload and source_code_hash"
}

variable "lambda_timeout" {
  type = number
}

variable "memory_size" {
  type = number
}

variable "api_throttle_burst_limit" {
  type = number
}

variable "api_throttle_rate_limit" {
  type = number
}

variable "openai_api_key" {
  type      = string
  sensitive = true
}

variable "clerk_jwks_url" {
  type = string
}

variable "clerk_issuer" {
  type = string
}

variable "agent_mode" {
  type = string
}

variable "llm_base_url" {
  type = string
}

variable "upload_storage" {
  type = string
}

variable "s3_prefix" {
  type = string
}

variable "s3_sse" {
  type = string
}
