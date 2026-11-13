plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.stepviewer"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.stepviewer"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        debug { isMinifyEnabled = false }
        release {
            isMinifyEnabled = false
            // чтобы APK из CI можно было сразу поставить, подписываем debug-ключом
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    androidResources { noCompress += listOf("wasm") }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.webkit:webkit:1.11.0")
}

// Понятная ошибка, если веб-библиотеки не скачаны
tasks.register("checkWebLibs") {
    doLast {
        val lib = file("src/main/assets/viewer/lib")
        val need = listOf("occt-import-js.js", "occt-import-js.wasm", "three.module.js",
                          "addons/controls/OrbitControls.js")
        val missing = need.filterNot { File(lib, it).exists() }
        if (missing.isNotEmpty()) throw GradleException(
            "Нет файлов: $missing. Запустите scripts/fetch-libs.sh (нужен Node.js)."
        )
    }
}
tasks.named("preBuild") { dependsOn("checkWebLibs") }
