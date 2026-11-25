# Sample: one Windows 11 VM on Azure that windows-session-ctl can drive.
# Copy this folder, fill in terraform.tfvars (see terraform.tfvars.example), then: terraform init && terraform apply

terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~>3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~>3.0"
    }
  }
}

# Uses your `az login` session.
provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

resource "azurerm_resource_group" "main" {
  name     = var.org
  location = var.location
}

# Holds the VM's init script, which the CustomScriptExtension downloads.
resource "azurerm_storage_account" "scripts" {
  name                     = "${var.org}vmscripts" # globally unique, 3-24 lowercase letters and digits
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

module "windows_vm" {
  source = "./modules/azure_windows"
  providers = {
    azurerm = azurerm
  }

  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location

  vm_name           = var.vm_name
  vm_size           = var.vm_size
  vm_admin_username = var.vm_admin_username
  dns_label         = "${var.org}-${var.vm_name}" # <label>.<region>.cloudapp.azure.com

  source_image_reference = {
    publisher = "MicrosoftWindowsDesktop"
    offer     = "windows-11"
    sku       = "win11-24h2-pro"
    version   = "latest"
  }

  # RDP, Chocolatey, your SSH key and OpenSSH Server
  init_script    = "init-win11-minimal.ps1"
  ssh_public_key = file(pathexpand(var.ssh_public_key_file))

  storage_account_name               = azurerm_storage_account.scripts.name
  storage_account_primary_access_key = azurerm_storage_account.scripts.primary_access_key
}
