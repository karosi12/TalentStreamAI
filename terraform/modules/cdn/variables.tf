variable "name_prefix" {
  type        = string
  description = "Prefix for tagging / naming context"
}

variable "tags" {
  type        = map(string)
  description = "Tags for CloudFront"
  default     = {}
}

variable "use_custom_domain" {
  type        = bool
  description = "Enable ACM cert and Route53 aliases for CloudFront"
}

variable "root_domain" {
  type        = string
  description = "Apex domain when use_custom_domain is true"
}

variable "frontend_website_endpoint" {
  type        = string
  description = "S3 static website endpoint hostname"
}

variable "frontend_bucket_id" {
  type        = string
  description = "Frontend bucket id (for CloudFront origin id)"
}
