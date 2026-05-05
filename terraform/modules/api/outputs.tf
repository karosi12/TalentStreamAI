output "api_gateway_url" {
  description = "HTTP API endpoint URL"
  value       = aws_apigatewayv2_api.main.api_endpoint
}

output "lambda_function_name" {
  description = "Deployed Lambda function name"
  value       = aws_lambda_function.api.function_name
}
