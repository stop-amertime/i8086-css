static const char STR_4BYTES[] = "hell";
static const char STR_8BYTES[] = "o world!";

void (*writeChar1)(char);
void (*writeChar4)(const char[4]);
void (*writeChar8)(const char[8]);
char (*readInput)(void);

int _start(void) {
  // Set up custom stuff
  writeChar1 = (void*)(0x2000);
  writeChar4 = (void*)(0x2002);
  writeChar8 = (void*)(0x2004);
  readInput = (void*)(0x2006);
  int* SHOW_KEYBOARD = (int*)(0x2100);

  // Write a single byte to screen
  writeChar1(0x0a);
  // Write 4 bytes from pointer to screen
  writeChar4(STR_4BYTES);
  // Write 8 bytes from pointer to screen
  writeChar8(STR_8BYTES);
  // Write a character from custom charset
  writeChar1(0x80);

  while (1) {
    // Show numeric keyboard
    *SHOW_KEYBOARD = 1;
    // Read keyboard input
    char input = readInput();
    if (!input) continue;
    *SHOW_KEYBOARD = 0;
    // Echo input
    writeChar1(input);
    break;
  }

  while (1) {
    // Show alphanumeric keyboard
    *SHOW_KEYBOARD = 2;
    char input = readInput();
    if (!input) continue;
    *SHOW_KEYBOARD = 0;
    writeChar1(input);
    break;
  }

  return 1337;
}