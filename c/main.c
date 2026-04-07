//https://stackoverflow.com/a/66809749
void *memcpy(void *dest, const void *src, int n)
{
    for (int i = 0; i < n; i++)
    {
        ((char*)dest)[i] = ((char*)src)[i];
    }
}

static const char STR_FIBONACCI[] = "Fibonacci sequence:\n\x00\x00\x00\x00\x00";
static const char WELCOME_TO_CSS[] = "Welcome to CSS-OS!\x00\x00\x00\x00\x00\x00\x00\x00";
static const char PICK_A_DEMO[] = "\nPick a demo:\n 1 - fibonacci sequence\n 2 - pascal's triangle\n 3 - horsle\n\n 0 - exit\n\nYour choice: \x00\x00\x00\x00\x00\x00\x00\x00";
static const char INVALID_OPTION[] = "Invalid option\n\x00\x00";
static const char PROMPT[] = "\x0a$ \x00";

void (*writeChar1)(char);
void (*writeChar4)(const char[4]);
void (*writeChar8)(const char[8]);
char (*readInput)(void);

void printString(const char src[]) {
  int i = 0;
  while (src[i]) {
    writeChar8( (const char*)((int)src+i) );
    i+=8;
  }
}

void printInt(int num) {
  int compValue = 10000;
  while (compValue > num)
    compValue = compValue / 10;
  while (compValue) {
    int val = num/compValue;
    writeChar1(0x30 + val);
    num -= val*compValue;
    compValue = compValue / 10;
  } 
}


void fibonacci(void) {
  int i, n;
  int t1 = 0, t2 = 1;
  int nextTerm = t1 + t2;

  printString(STR_FIBONACCI);
  writeChar1(0x30);
  writeChar1(0x20);
  writeChar1(0x31);
  writeChar1(0x20);

  for (i = 3; i <= 12; ++i) {
    int tmp = nextTerm/10;
    if (tmp)
      writeChar1(0x30 + tmp);
    writeChar1(0x30 + (nextTerm%10));
    writeChar1(0x20);
    t1 = t2;
    t2 = nextTerm;
    nextTerm = t1 + t2;
  }
  return;
}

void pascal(void) {
    int n=5,c=1,i,j;

    for(i=0;i<n;i++) {
        for(j=1;j<n-i;j++) {
          writeChar1(0x20);
          writeChar1(0x20);
        }
        for(j=0;j<=i;j++) {
            if (j==0||i==0)
              c=1;
            else
               c=c*(i-j+1)/j;
            writeChar1(0x20);
            writeChar1(0x20);
            writeChar1(0x20);
            writeChar1(0x30 + c);
        }
        writeChar1(0x0a);
    }
}

static const char STR_HORSLE[] = "  [ \x80 Horsle ]\nType a 5 letter word:\n\x00\x00\x00\x00";
static const char STR_YOU_WIN[] = "You win!!\x00\x00\x00\x00\x00\x00\x00\x00";
static const char STR_YOU_LOSE[] = "You lose :c\nThe word was: HORSE\x00\x00";
static const char STR_HORSE[] = "HORSE";
static char horsle_word[] = {0x0,0x0,0x0,0x0,0x0};
void horsle(void) {
  int i,win=0,j=0;
  int* SHOW_KEYBOARD = (int*)(0x2100);
  printString(STR_HORSLE);
  while (j < 5) {
    int i = 0;
    while (i < 5) {
      *SHOW_KEYBOARD = 2;
      char input = readInput();
      if (!input) continue;
      *SHOW_KEYBOARD = 0;
      horsle_word[i] = input;
      writeChar1(0x20);
      writeChar1(input);
      writeChar1(0x20);
      i++;
    }
    i = 0;
    win = 1;
    writeChar1(0x0a);
    while (i < 5) {
      char a = horsle_word[i];
      char b = STR_HORSE[i];
      int matches = 0;
      if (a == b) {
        writeChar1(0x83);
        i++;
        continue;
      }
      win = 0;
      if (a == 0x48) matches++;
      if (a == 0x4f) matches++;
      if (a == 0x52) matches++;
      if (a == 0x53) matches++;
      if (a == 0x45) matches++;
      writeChar1(matches?0x82:0x81);
      i++;
    }
    writeChar1(0x0a);
    if (win) {
      printString(STR_YOU_WIN);
      return;
    }
    j++;
  }
  printString(STR_YOU_LOSE);
}

/*
static const char STR_NOTEPAD[] = "just write whatever u want:\n\x00\x00\x00\x00\x00";
void notepad(void) {
  int* SHOW_KEYBOARD = (int*)(0x2100);
  printString(STR_NOTEPAD);
  while (1) {
    *SHOW_KEYBOARD = 2;
    char input = readInput();
    if (!input) continue;
    *SHOW_KEYBOARD = 0;
    writeChar1(input);
  }
}*/

int _start(void) {
  writeChar1 = (void*)(0x2000);
  writeChar4 = (void*)(0x2002);
  writeChar8 = (void*)(0x2004);
  readInput = (void*)(0x2006);
  int* SHOW_KEYBOARD = (int*)(0x2100);
  printString(WELCOME_TO_CSS);
  //writeChar4(PROMPT);
  printString(PICK_A_DEMO);
  // writeChar4(PROMPT);

  while (1) {
    //while(readInput()){}
    *SHOW_KEYBOARD = 1;
    char input = readInput();
    if (!input) continue;
    *SHOW_KEYBOARD = 0;
    writeChar1(input);
    writeChar1(0x0a);
    switch (input) {
      case 0x30:
        return 1337;
        break;
      case 0x31:
        fibonacci();
        break;
      case 0x32:
        pascal();
        break;
      case 0x33:
        horsle();
        break;
      default:
        printString(INVALID_OPTION);
    }
    printString(PICK_A_DEMO);
  }
  return 67;
}