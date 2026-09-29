# Windows-এ ইনস্টল ও ব্যবহার (Install on Windows)

## ১. দুটি প্রোগ্রাম ইনস্টল করুন (একবারই)
1. **Node.js 22 LTS** – https://nodejs.org থেকে নামিয়ে ইনস্টল করুন (Next-Next করে)।
2. **PostgreSQL 16** – https://www.postgresql.org/download/windows/ থেকে নামান।
   ইনস্টল করার সময় `postgres` ইউজারের **পাসওয়ার্ড** দিতে বলবে – সেটি মনে রাখুন। পোর্ট `5432` ই রাখুন।

## ২. প্রজেক্ট নামান
GitHub থেকে ZIP ডাউনলোড করে Extract করুন (Branch: `claude/company-app-development-h9tjru`),
অথবা: `git clone -b claude/company-app-development-h9tjru https://github.com/milo9sheikh/app.git`

## ৩. সেটআপ (একবারই)
`windows\setup.bat` এ ডাবল-ক্লিক করুন।
- প্রথমবার এটি `.env` ফাইল বানিয়ে Notepad-এ খুলবে। সেখানে `CHANGE_...` লেখাগুলো বদলান:
  PostgreSQL পাসওয়ার্ড, আপনার Admin পাসওয়ার্ড, আর একটি লম্বা গোপন লেখা। Save করে আবার `setup.bat` চালান।
- এবার এটি প্রয়োজনীয় ফাইল ইনস্টল করে ডাটাবেস বানাবে।

## ৪. চালু করুন
`windows\start.bat` এ ডাবল-ক্লিক করুন। দুটি কালো উইন্ডো খুলবে (বন্ধ করবেন না) এবং ব্রাউজারে
**http://localhost:3000** খুলবে। Email `admin@example.com` (বা `.env`-এ যা দিয়েছেন) ও আপনার Admin পাসওয়ার্ড দিয়ে লগইন করুন।

অফিসের অন্য কম্পিউটার থেকে খুলতে: `http://<এই পিসির-IP>:3000` এবং Windows Firewall-এ পোর্ট 3000 Allow করুন।

## ৫. প্রথম ব্যবহার
1. Sites / Departments / Shifts (Start 09:00, Cutoff 09:15) তৈরি করুন।
2. Employees → কর্মী যোগ → **Devices** থেকে তার ফোনের MAC অ্যাড্রেস দিন।
3. Routers → Router যোগ করুন।
   ⚠ **আসল রাউটারের সাথে সংযোগ এখনো তৈরি হয়নি।** এখন শুধু `MOCK` (ডেমো) টাইপ কাজ করে। আপনার রাউটারের ব্র্যান্ড/মডেল জানালে আমি সেটির adapter বানাবো।
   ডেমো: MOCK রাউটারের **API path** ঘরে `AA:BB:CC:DD:EE:01` লিখলে ঐ ডিভাইস কানেক্টেড ধরা হবে।

## সমস্যা হলে
- `Cannot connect to PostgreSQL` → PostgreSQL চালু আছে কি? `.env`-এর পাসওয়ার্ড ঠিক আছে কি?
- `node` চেনে না → Node.js ইনস্টলের পর নতুন করে Command Prompt/setup.bat চালান।
- ফোনের MAC: ফোনে "Private/Random WiFi address" চালু থাকলে MAC বদলে যেতে পারে – ঐ WiFi নেটওয়ার্কের জন্য সেটি বন্ধ করুন।
- ডাটা ব্যাকআপ: PostgreSQL এর `attendance` ডাটাবেস নিয়মিত backup নিন (pgAdmin → Backup)।

---
## সহজ পথ: এক-ফাইলের ইনস্টলার (.exe)
`WiFiAttendance-Setup.exe` চালালেই Node.js, PostgreSQL ও অ্যাপ একসাথে ইনস্টল হয়ে যায় — আলাদা কিছু ইনস্টল করতে হয় না।
- ইনস্টল হয় `%LOCALAPPDATA%\Programs\WiFiAttendance`, ডাটা থাকে `%LOCALAPPDATA%\WiFiAttendance` (আনইনস্টলে ডাটা মোছে না)।
- Desktop-এর **WiFi Attendance** শর্টকাটে ডাবল-ক্লিক করলে অ্যাপ চালু হয় ও ব্রাউজার খোলে। প্রথমবার লগইন তথ্য (`first-login.txt`) Notepad-এ খুলবে।
- বন্ধ করতে কালো উইন্ডোটি বন্ধ করুন, বা Start Menu থেকে **Stop WiFi Attendance**।
- Windows "Unknown publisher" সতর্কতা দিলে **More info → Run anyway** চাপুন (ইনস্টলারটি সাইন করা নয়)।
- ডাটাবেস চালু না হলে "Microsoft Visual C++ Redistributable 2015-2022 (x64)" ইনস্টল করুন।
- নিজে বানাতে: `bash installer/build.sh` (Linux/macOS, `nsis` লাগবে)।
