# Windows VM Core Outputs
output "vm_id" {
  description = "ID of the Windows VM"
  value       = azurerm_windows_virtual_machine.windows_vm.id
}

output "vm_name" {
  description = "Name of the Windows VM"
  value       = azurerm_windows_virtual_machine.windows_vm.name
}

output "vm_size" {
  description = "Size of the Windows VM"
  value       = azurerm_windows_virtual_machine.windows_vm.size
}

# Network Outputs
output "vm_public_ip" {
  description = "Public IP address of the Windows VM"
  value       = azurerm_public_ip.vm_public_ip.ip_address
}

output "vm_private_ip" {
  description = "Private IP address of the Windows VM"
  value       = azurerm_network_interface.vm_nic.private_ip_address
}

output "vm_fqdn" {
  description = "Fully qualified domain name of the VM"
  value       = azurerm_public_ip.vm_public_ip.fqdn
}

# Authentication Outputs
output "vm_admin_password" {
  description = "Admin password for the Windows VM"
  value       = random_password.vm_password.result
  sensitive   = true
}

output "vm_admin_username" {
  description = "Admin username for the Windows VM"
  value       = var.vm_admin_username
}

# Connection Information
output "rdp_connection_string" {
  description = "RDP connection command"
  value       = "mstsc /v:${azurerm_public_ip.vm_public_ip.ip_address}"
}

# Network Information
output "vnet_id" {
  description = "ID of the virtual network"
  value       = azurerm_virtual_network.vm_network.id
}

output "subnet_id" {
  description = "ID of the subnet"
  value       = azurerm_subnet.vm_subnet.id
}

# Resource Group Information
output "resource_group_name" {
  description = "Resource group name"
  value       = var.resource_group_name
}

output "location" {
  description = "Azure region where resources are created"
  value       = var.location
}

