output "vm_fqdn" {
  value = module.windows_vm.vm_fqdn
}

output "vm_admin_username" {
  value = module.windows_vm.vm_admin_username
}

output "vm_admin_password" {
  value     = module.windows_vm.vm_admin_password
  sensitive = true
}
