import os
import subprocess
import re
import shutil

# compile the file ./c/[BASE_NAME].c
BASE_NAME = "main"
# use these compiler flags
FLAGS = "-nostdlib -Os" # you can also use -O2

bash_prefix = ["bash", "-c"]
# for wsl1/2 support
if os.name == 'nt':
    bash_prefix = ["wsl"] + bash_prefix

def build():
    try:
        os.makedirs("./tmp")
    except FileExistsError:
        pass

    command = f"ia16-elf-gcc c/{BASE_NAME}.c -o tmp/{BASE_NAME}.a {FLAGS}"
    res =  subprocess.run([*bash_prefix, command], capture_output=True, text=True)
    print(res.stdout)
    print(res.stderr)

    if res.returncode != 0:
        raise Exception(str(res.returncode))

def asm_build():
    command = f"ia16-elf-gcc c/{BASE_NAME}.c -o tmp/{BASE_NAME}.o {FLAGS} -c"
    #
    res =  subprocess.run([*bash_prefix, command], capture_output=True, text=True)
    print(res.stdout)
    print(res.stderr)

    if res.returncode != 0:
        raise Exception(str(res.returncode))

    command = f"ia16-elf-objdump -Mi8086 -Mintel --adjust-vma=256 -fd tmp/{BASE_NAME}.o"
    res =  subprocess.run([*bash_prefix, command], capture_output=True, text=True)
    return res.stdout

def get_function_addresses():
    command = f'ia16-elf-nm tmp/{BASE_NAME}.o'
    nm = subprocess.run([*bash_prefix, command], capture_output=True, text=True, check=True)
    funcs = {}
    for line in nm.stdout.splitlines():
        match = re.match(r"([0-9a-f]+) T (\w+)$", line.strip())
        if match:
            funcs[match.group(2)] = int(match.group(1), 16)
    return funcs

def full_build():
    build()
    print(asm_build())
    addrs = get_function_addresses()
    shutil.copyfile(f"tmp/{BASE_NAME}.a", "program.bin")
    with open("program.bin", "rb") as f:
        s = len(f.read())
        print("program size:", s, hex(s))
    with open("program.start", "w") as f:
        f.write(str(addrs["_start"]))

if __name__ == '__main__':
    print(full_build())
