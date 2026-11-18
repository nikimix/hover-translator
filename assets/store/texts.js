// Подписи на картинках магазина. Коротко и крупно: в магазине скриншоты уменьшаются до 640×400.
// <k>…</k> — клавиша (рисуется как кнопка клавиатуры); <n>…</n> — без переноса строки внутри.
window.TEXTS = {
  en: {
    s1: { h: "Point at text, press <n><k>Shift</k>&nbsp;—</n> it’s translated right on the page", sub: "Links, bold text and layout stay as they were", before: "Before", after: "After" },
    s2: { h: "Or read the translation in a card next to the text", sub: "The original stays as it is" },
    s3: { h: "Pick a language and how to translate", sub: "<k>Shift</k>, <k>Alt</k>, <n><k>Ctrl</k>&nbsp;—</n> or simply hover" },
    s4: { h: "Translate the whole page in one click", sub: "A button in the extension window or <k>Alt</k>+<k>Shift</k>+<k>G</k>" },
    s5: {
      h: "Free and private",
      points: [
        ["chip", "Chrome’s built-in translator works on your computer: no keys, no sign-up, your text stays with you"],
        ["key", "DeepL and AI are optional&nbsp;— with your own key and only after you agree"],
      ],
    },
    promo: { name: "Hover Translator", tag: "Translate text right where you read it" },
  },
  ru: {
    s1: { h: "Наведите курсор на текст и нажмите <n><k>Shift</k>&nbsp;—</n> перевод появится прямо на странице", sub: "Ссылки и оформление остаются как были", before: "До", after: "После" },
    s2: { h: "Или читайте перевод в карточке рядом с текстом", sub: "Оригинал при этом не меняется" },
    s3: { h: "Выберите язык и способ перевода", sub: "<k>Shift</k>, <k>Alt</k>, <n><k>Ctrl</k>&nbsp;—</n> или просто наведение курсора" },
    s4: { h: "Вся страница&nbsp;— одним нажатием", sub: "Кнопка в окне расширения или <k>Alt</k>+<k>Shift</k>+<k>G</k>" },
    s5: {
      h: "Бесплатно и приватно",
      points: [
        ["chip", "Встроенный переводчик Chrome работает на вашем компьютере: без ключей и регистрации, текст никуда не уходит"],
        ["key", "DeepL и ИИ&nbsp;— по желанию: со своим ключом и только с вашего согласия"],
      ],
    },
    promo: { name: "Переводчик при наведении", tag: "Перевод прямо там, где вы читаете" },
  },
};
