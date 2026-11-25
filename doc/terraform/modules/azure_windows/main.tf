# Terraform configuration for this module
terraform {
  required_providers {
    azurerm = {
      source                = "hashicorp/azurerm"
      version               = "~>3.0"
      configuration_aliases = [azurerm]
    }
    random = {
      source  = "hashicorp/random"
      version = "~>3.0"
    }
  }
}

# Windows VM Virtual Network
resource "azurerm_virtual_network" "vm_network" {
  provider            = azurerm
  name                = "${var.vm_name}-network"
  address_space       = ["10.0.0.0/16"]
  location            = var.location
  resource_group_name = var.resource_group_name

  tags = {
    Purpose = "Windows VM for windows-session-ctl"
  }
}

# Windows VM Subnet
resource "azurerm_subnet" "vm_subnet" {
  provider = azurerm

  name                 = "${var.vm_name}-subnet"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.vm_network.name
  address_prefixes     = ["10.0.1.0/24"]
}

# Windows VM Network Security Group
resource "azurerm_network_security_group" "vm_nsg" {
  provider = azurerm

  name                = "${var.vm_name}-nsg"
  location            = var.location
  resource_group_name = var.resource_group_name

  # Allow RDP (Remote Desktop Protocol) for Windows
  security_rule {
    name                       = "RDP"
    priority                   = 1001
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "3389"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  # Allow SSH for rsync and file transfer
  security_rule {
    name                       = "SSH"
    priority                   = 1003
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  tags = {
    Purpose = "Windows VM for windows-session-ctl"
  }
}

# Associate NSG with subnet
resource "azurerm_subnet_network_security_group_association" "vm_nsg_association" {
  provider = azurerm

  subnet_id                 = azurerm_subnet.vm_subnet.id
  network_security_group_id = azurerm_network_security_group.vm_nsg.id
}

# Windows VM Public IP
resource "azurerm_public_ip" "vm_public_ip" {
  provider = azurerm

  name                = "${var.vm_name}-public-ip"
  resource_group_name = var.resource_group_name
  location            = var.location
  allocation_method   = "Static"
  sku                 = "Standard"
  domain_name_label   = var.dns_label # <label>.<region>.cloudapp.azure.com; null = no DNS name

  tags = {
    Purpose = "Windows VM for windows-session-ctl"
  }
}

# Windows VM Network Interface
resource "azurerm_network_interface" "vm_nic" {
  provider = azurerm

  name                = "${var.vm_name}-nic"
  location            = var.location
  resource_group_name = var.resource_group_name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.vm_subnet.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.vm_public_ip.id
  }

  tags = {
    Purpose = "Windows VM for windows-session-ctl"
  }
}

# Random password for Windows VM
resource "random_password" "vm_password" {
  length  = 16
  special = true
}

# Windows VM - Basic installation without provisioning
resource "azurerm_windows_virtual_machine" "windows_vm" {
  provider = azurerm

  name                = var.vm_name
  computer_name       = substr(var.vm_name, 0, 15) # Truncate to 15 chars (hyphens are allowed)
  resource_group_name = var.resource_group_name
  location            = var.location
  size                = var.vm_size
  admin_username      = var.vm_admin_username
  admin_password      = random_password.vm_password.result

  network_interface_ids = [
    azurerm_network_interface.vm_nic.id,
  ]

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
    disk_size_gb         = 128
  }

  source_image_reference {
    publisher = var.source_image_reference.publisher
    offer     = var.source_image_reference.offer
    sku       = var.source_image_reference.sku
    version   = var.source_image_reference.version
  }

  enable_automatic_updates          = true
  provision_vm_agent                = true
  vm_agent_platform_updates_enabled = true

  tags = {
    Purpose = "Windows VM for windows-session-ctl"
    Note    = "Basic Windows installation - no additional provisioning"
  }

  depends_on = [
    azurerm_subnet_network_security_group_association.vm_nsg_association
  ]
}

# Create a container for VM setup scripts
resource "azurerm_storage_container" "vmscripts" {
  provider = azurerm

  name                  = "vmscripts"
  storage_account_name  = var.storage_account_name
  container_access_type = "blob"
}

# Upload the init script to Azure Blob Storage
resource "azurerm_storage_blob" "init_script" {
  provider = azurerm

  name                   = var.init_script
  storage_account_name   = var.storage_account_name
  storage_container_name = azurerm_storage_container.vmscripts.name
  type                   = "Block"
  source                 = "${path.module}/${var.init_script}"
}

# VM Extension that downloads and runs the init script (only if run_init_script is true)
resource "azurerm_virtual_machine_extension" "init_script" {
  count    = var.run_init_script ? 1 : 0
  provider = azurerm

  name                       = "InitScript"
  virtual_machine_id         = azurerm_windows_virtual_machine.windows_vm.id
  publisher                  = "Microsoft.Compute"
  type                       = "CustomScriptExtension"
  type_handler_version       = "1.10"
  auto_upgrade_minor_version = true

  settings = jsonencode({
    fileUris = [azurerm_storage_blob.init_script.url]
  })

  protected_settings = jsonencode({
    commandToExecute   = "powershell -ExecutionPolicy Bypass -File ${var.init_script} -SshPublicKey \"${replace(var.ssh_public_key, "\"", "\\\"")}\" -AdminUser \"${var.vm_admin_username}\""
    storageAccountName = var.storage_account_name
    storageAccountKey  = var.storage_account_primary_access_key
  })

  # Phase 1 + 2 installs (Windows SDK, .NET, Azure CLI...) can exceed the 30m default.
  timeouts {
    create = "60m"
    update = "60m"
  }

  depends_on = [
    azurerm_windows_virtual_machine.windows_vm,
    azurerm_storage_blob.init_script
  ]
}