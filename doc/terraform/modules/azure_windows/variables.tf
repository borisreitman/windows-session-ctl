# Basic Configuration
variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "location" {
  description = "Azure region where resources will be created"
  type        = string
}

# Windows VM Configuration
variable "vm_size" {
  description = "Size of the Windows VM"
  type        = string
  default     = "Standard_B2s" # 2 vCPUs, 4GB RAM - sufficient for basic testing
}

variable "vm_admin_username" {
  description = "Administrator username for Windows VM"
  type        = string
  default     = "azureuser"
}

# Optional: VM Name
variable "vm_name" {
  description = "Name of the Windows VM"
  type        = string
  default     = "windows-test-vm"
}

# Windows Image Configuration
variable "source_image_reference" {
  description = "Source image reference for the Windows VM (publisher, offer, sku, version)"
  type = object({
    publisher = string
    offer     = string
    sku       = string
    version   = string
  })
}

# Init Script Configuration
variable "init_script" {
  description = "Init script filename to run on the VM (e.g., 'init-ssh-only.ps1', 'init-windows-tools.ps1')"
  type        = string
}

variable "run_init_script" {
  description = "Whether to automatically run the init script via VM extension. Set to false to skip and run manually."
  type        = bool
  default     = true
}

variable "ssh_public_key" {
  description = "SSH public key content for authentication"
  type        = string
}

variable "storage_account_name" {
  description = "Azure Storage Account name for VM scripts"
  type        = string
}

variable "storage_account_resource_group_name" {
  description = "Resource group name where the storage account exists (defaults to resource_group_name if not specified)"
  type        = string
  default     = null
}

variable "storage_account_primary_access_key" {
  description = "Primary access key for the storage account"
  type        = string
  sensitive   = true
}


variable "dns_label" {
  description = "Azure DNS label for the public IP (<label>.<region>.cloudapp.azure.com). Must be unique in the region; lowercase letters, digits and hyphens. null = no DNS name."
  type        = string
  default     = null
}
