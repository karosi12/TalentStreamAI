variable "project_name" {
  description = "Name prefix for all resources"
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.project_name))
    error_message = "Project name must contain only lowercase letters, numbers, and hyphens."
  }
  default = "talentstreamai"
}

variable "environment" {
  description = "Environment name (dev, test, prod)"
  type        = string
  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "Environment must be one of: dev, test, prod."
  }
}


variable "lambda_timeout" {
  description = "Lambda function timeout in seconds"
  type        = number
  default     = 120
}

variable "memory_size" {
  description = "Lambda function memory size in MB"
  type        = number
  default     = 512

}

variable "api_throttle_burst_limit" {
  description = "API Gateway throttle burst limit"
  type        = number
  default     = 100
}

variable "api_throttle_rate_limit" {
  description = "API Gateway throttle rate limit"
  type        = number
  default     = 50
}

variable "use_custom_domain" {
  description = "Attach a custom domain to CloudFront"
  type        = bool
  default     = false
}

variable "root_domain" {
  description = "Apex domain name, e.g. mydomain.com"
  type        = string
  default     = ""
}
variable "aws_region" {
  description = "deployment region"
  type        = string
  default     = "us-east-1"
}

variable "openai_api_key" {
  description = "OPENAI api key"
  type        = string
}

variable "clerk_jwks_url" {
  description = "Clerk JWKS URL"
  type        = string
}

variable "clerk_issuer" {
  description = "Clerk issuer URL"
  type        = string
}

variable "agent_mode" {
  description = "Agent mode"
  type        = string
}

variable "llm_base_url" {
  description = "LLM base URL"
  type        = string
}

variable "s3_prefix" {
  description = "S3 prefix"
  type        = string
}

variable "s3_sse" {
  description = "S3 SSE"
  type        = string
}

variable "upload_storage" {
  description = "Upload storage"
  type        = string
}