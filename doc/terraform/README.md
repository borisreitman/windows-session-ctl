# Sample Terraform: a Windows VM for windows-session-ctl

Creates a resource group, a storage account for the init script, a network, a security group, a static public IP with a DNS
name, and a Windows 11 VM with RDP and OpenSSH. Replace `yourorg` and the subscription ID; nothing else is specific to
anyone.

```bash
cp terraform.tfvars.example terraform.tfvars    # edit it
az login
terraform init
terraform apply
terraform output -raw vm_admin_password         # for RDP
```

Then log in over RDP (the tool needs a logged-in desktop) and connect the tool:

```bash
windows-session-ctl profile add win11 --host "$(terraform output -raw vm_fqdn)" --key ~/.ssh/id_ed25519
windows-session-ctl install
```

**Security.** The security group allows RDP (3389) and SSH (22) from **any** address (`source_address_prefix = "*"`).
For anything but a short-lived test machine, restrict that to your own address range in
`modules/azure_windows/main.tf`.

**HTTPS transport.** `install --az` (or `profile add --transport https --vm win11-test`) additionally needs the agent port
(default 8443) to be reachable. The tool never changes the security group. If you want that route, add a rule yourself,
limited to your address:

```hcl
  security_rule {
    name                       = "windows-session-ctl"
    priority                   = 1004
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "8443"
    source_address_prefix      = "203.0.113.10/32" # your public IP
    destination_address_prefix = "*"
  }
```

The VM and its disk and public IP cost money while they exist; `terraform destroy` removes everything.
