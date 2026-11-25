variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
}

variable "org" {
  description = "Short name for your organisation; prefixes the resource group, storage account and DNS label"
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,14}$", var.org))
    error_message = "org must be 2-15 lowercase letters or digits, starting with a letter."
  }
}

variable "location" {
  type    = string
  default = "eastus"
}

variable "vm_name" {
  type    = string
  default = "win11-test"
}

variable "vm_size" {
  type    = string
  default = "Standard_B2s"
}

variable "vm_admin_username" {
  type    = string
  default = "azureuser"
}

variable "ssh_public_key_file" {
  description = "Public key that may log in to the VM over SSH"
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}
